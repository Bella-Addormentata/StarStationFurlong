/**
 * StarStation Furlong - Core Loop Demo
 * Main entry point — orthographic camera + hybrid WASD / point-and-click nav.
 */

import * as THREE from 'three';
import './style.css';
import { updateDebugHUD, showHint } from './hud';
import type { World } from './world';
import type { DoorId } from './doors';
import type { InputManager } from './input';
import { NetworkProvider } from './network/NetworkProvider';
import { YjsSync } from './network/YjsSync';
import { packTick, unpackTick, unpackAddressedTick, ADDRESSED_TICK_BYTES, TICK_BYTES, type MovementTick, type RoomBootstrap, type RoomMemberHint } from './network/protocol';
import { MultiScaleZoomView } from './zoom';
import { initCameraRig, updateCameraRig } from './cameraRig';
import { getOutfitById, loadSavedOutfitId, saveOutfitId } from './outfits';
import { deviceFocus, isDeviceFocusActive } from './deviceFocus';
import { getPlayerId, getPlayerName, setPlayerName, PLAYER_NAME_MAX_LENGTH, getDefaultRoomId } from './identity';
import {
  getIdentityPub, getIdentityFingerprint, signNameCert, verifyNameCert,
  exportRecoveryKey, importRecoveryKey, ysyncSigner,
} from './keypair';
import { roomEdit, setRoomEditPermission } from './editMode';
import { bindGamesDoc } from './games/gamesDoc';
import { bindFurnitureDoc, seedFurnitureDefaults, furnitureDocSize } from './furnitureDoc';
import {
  initRoomPasses, addPass, listPasses, passState, subscribePasses,
  setActivePassRoom, removePass, passRoomInfo, passSeed, type PassState,
} from './roomPasses';
import {
  initContacts, listContacts, listFriends, subscribeContacts, contactFingerprint,
  encodeMyCard, addContactFromCard, setFriend, removeContact, getContact,
  isDiscoverable, setDiscoverable, reconstructCard, type ContactCard,
} from './contacts';
import {
  makeIntroductions, ingestIntroduction, type Introduction,
} from './introductions';
import {
  initDirectMessages, openDm, sendMessage, readMessages, closeDm, closeAllDms,
  dmRoomIdFor, dmRoomKeyFor, type DmSession, type DirectMessage,
} from './directMessages';
import {
  initPeerStore, recordPeer, hintsFor, peerCount, listPeers, subscribePeers, getPeer,
} from './peerStore';

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
let multiScaleZoom: MultiScaleZoomView;

// ── Raycasting (point-and-click navigation) ───────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();

// Sovereign real-time networking state (Sprint 3)
const networkProvider = new NetworkProvider();
(window as any).networkProvider = networkProvider;
// Publish the per-install default room id early so pre-join readers of
// __ssfRoomId (world / roomInventory / devMenu local-state keys) get the unique
// home id rather than a shared literal (dev-stage collision fix). Overwritten
// with the actual room on join.
(window as any).__ssfRoomId = getDefaultRoomId();

// Keyed-identity Slice 1: expose the identity for verification + the recovery
// backup/restore flow (the polished UI lands with the Contacts app, Slice 3).
(window as any).__ssfIdentity = {
  getPub: () => getIdentityPub(),
  getFingerprint: () => getIdentityFingerprint(),
  exportRecoveryKey: () => exportRecoveryKey(),
  importRecoveryKey: (r: string) => importRecoveryKey(r),
  verifyNameCert,
};
// DM pair-derivation debug hook (deterministic room/key from a peer pubkey).
(window as any).__ssfDM = { roomIdFor: dmRoomIdFor, roomKeyFor: dmRoomKeyFor };
// 🕸️ Mesh peer-store debug hook (§7 M1).
(window as any).__ssfMesh = { count: () => peerCount(), list: () => listPeers(), hintsFor };
let yjsSync: YjsSync | null = null;
// Session-epoch guard (issue #30 T0 review): every joinRoom() claims a fresh
// epoch and every leaveRoom() invalidates the current one. joinRoom re-checks
// the epoch after EACH await and unwinds if superseded — otherwise a rapid
// leave→join pair (double-clicked Use-link today, T1 transit tomorrow)
// interleaves two joins and the older one binds a live YjsSync to the newer
// session's transport/room.
let sessionEpoch = 0;
// Y.Doc lifecycle counter (issue #30 T0 verification aid): joinRoom()
// increments `created`, teardown increments `destroyed` once YjsSync.stop()
// has destroyed the doc. Live docs = created - destroyed and must never
// exceed 1. The counters themselves always run (so code paths don't fork);
// only the window handle is dev-gated. Nothing in gameplay reads either.
const ssfDocStats = { created: 0, destroyed: 0 };
if (import.meta.env.DEV) {
  (window as any).__ssfDocStats = ssfDocStats;
}
let localSeq = 0;
let lastTickSent = 0;
const seenPeers = new Set<string>();
let receivedTicks = 0;
// Remote-player liveness: last tick arrival per peer, swept in the game loop
// so ghost avatars despawn after silence (issue #22 follow-through).
const remoteLastSeen = new Map<string, number>();
const REMOTE_PEER_TIMEOUT_MS = 10_000;
const REMOTE_REAPER_SWEEP_MS = 2_000;
let lastReaperSweep = 0;
let pendingBootstrapOverride: RoomBootstrap | null = null;
let activeBootstrap: RoomBootstrap | null = null;
let networkPanelInitialized = false;
let phoneOverlayInitialized = false;
// ── Adapter transit state (T1 of issue #30) ──────────────────────────────────
/** Re-entrancy latch: one transit at a time (the player can only stand in
 *  one vestibule, and the fade/join sequence must never interleave). */
let transitInProgress = false;
/**
 * Room ids minted by THIS client THIS session via PROVISION NEW MODULE.
 * Transiting into one of them is a first-entry into a fresh room nobody
 * owns — pass claimRoomDefaults=true so the provisioner becomes the owner.
 * Every other transit is a JOIN into someone else's room (false).
 */
const mintedRoomIds = new Set<string>();

/** Staged room-list (issue #60): the passes manager is restored+warmed once,
 *  after the first join confirms the node is up. */
let roomPassesInited = false;

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
  /** R1: live reachability classification from the node —
   *  'port-mapped' | 'advertised' | 'cgnat' | 'local-only'.
   *  Optional: the Tauri fallback listener's fingerprint omits it. */
  reachability?: string;
  /** R1: the iroh UDP port ACTUALLY bound (post random-port fallback) —
   *  the port a router forward must target. */
  iroh_port?: number;
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

// ── R1 reachability readout ───────────────────────────────────────────────────
/** Node-side default iroh UDP pin — display fallback only; the fingerprint's
 *  `iroh_port` (the ACTUAL bound port, post random-port fallback) wins. */
const DEFAULT_IROH_UDP_PORT = 44442;

function reachabilityUdpPort(fp: LocalFingerprint | null): number {
  return fp?.iroh_port && fp.iroh_port > 0 ? fp.iroh_port : DEFAULT_IROH_UDP_PORT;
}

/** R1: REACHABILITY row — the node's live self-classification. 'advertised'
 *  is deliberately amber with a caveat: the echo-advertised address is
 *  UNVERIFIED (no external infra to probe inbound UDP), so it is a hint that
 *  usually works once the router forward exists, not a guarantee. */
function renderReachabilityRow(fp: LocalFingerprint | null): void {
  if (!fp) {
    setNetworkRow('network-reachability', 'NO NODE', '#ff1744');
    return;
  }
  const port = reachabilityUdpPort(fp);
  switch (fp.reachability) {
    case 'port-mapped':
      // "LIKELY": the public route may be a portmapper mapping (inbound works)
      // or a peer-observed reflexive address (inbound may still be blocked) —
      // provenance is inferred, so don't overclaim OPEN (R1 review M1).
      setNetworkRow('network-reachability', `LIKELY OPEN — public route detected (UDP ${port})`, '#7ddc5a');
      break;
    case 'advertised':
      setNetworkRow('network-reachability', `ADVERTISED — forward UDP ${port} if joins fail`, '#ffb300');
      break;
    case 'cgnat':
      setNetworkRow('network-reachability', 'CGNAT — direct dials impossible, needs relay', '#ff1744');
      break;
    case 'local-only':
      setNetworkRow('network-reachability', `LAN ONLY — set up UDP ${port} forward`, '#ff1744');
      break;
    default:
      // Older node / Tauri fallback listener: no classification available.
      setNetworkRow('network-reachability', '--');
      break;
  }
}

/** True when any outgoing direct-addr hint is a public IPv4 an internet peer
 *  could dial. IPv6 hints deliberately don't count — the invite pre-flight
 *  warns specifically about v4 reachability (the common home-NAT path). */
function bootstrapHasPublicIPv4(boot: RoomBootstrap): boolean {
  for (const hint of collectMemberHints(boot)) {
    for (const addr of hint.irohDirectAddrs ?? []) {
      const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(addr);
      if (v4 && classifyAddress(v4[1]) === 'public') return true;
    }
  }
  return false;
}

/** R1 invite pre-flight (lives in the ACCESS app since #52): warn — but the
 *  pass is STILL handed over — when nothing in it is dialable from the
 *  internet: no public IPv4 in the outgoing hints and no UPnP mapping to
 *  catch the dial. The IPv4 hints deliberately STAY in passes (owner
 *  decision: reliability over minimalism; DHT re-resolution keeps them
 *  refreshable), so a missing public v4 here is an honest LAN/IPv6-only
 *  signal. Returns null when the pass looks internet-dialable. */
function inviteReachabilityWarning(boot: RoomBootstrap | undefined): string | null {
  return boot && !bootstrapHasPublicIPv4(boot) && localFingerprint?.reachability !== 'port-mapped'
    ? `⚠ This pass has no internet-reachable IPv4 — LAN/IPv6 only. Forward UDP ${reachabilityUdpPort(localFingerprint)} on the router (auto-advertising is on by default).`
    : null;
}

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
    // One-time UI init: phone input behaviors, hooks, and date-stamps
    // (Task 4.1). Internally guarded (phoneOverlayInitialized) so re-entry
    // via Retry-node / Use-link never re-binds listeners (issue #30 T0).
    setupSpacePhoneOverlay();
    const override = pendingBootstrapOverride;
    let boot = override ?? await fetchDefaultBootstrap();
    // Stale-cert self-dial guard (node-restart bug): an override captured
    // before the local node restarted still carries the OLD WT cert hash, so
    // a loopback dial with it fails the TLS handshake on every Retry. The
    // live fingerprint is authoritative for LOCAL dials — refresh the hash
    // (and the WT port, which can drift the same way) before connecting.
    // Remote wtUrls are left alone: their certs aren't ours to know, and
    // non-loopback dial failures keep their RESTRICTED? diagnostics below.
    if (override) {
      try {
        if (classifyAddress(new URL(override.wtUrl).hostname) === 'loopback') {
          const fp = await awaitLocalNodeFingerprint();
          if (fp && fp.base64) {
            const wtUrl = new URL(override.wtUrl);
            wtUrl.port = String(fp.port);
            boot = { ...override, wtUrl: wtUrl.toString(), certHashesB64: [fp.base64] };
            pendingBootstrapOverride = boot; // future retries stay coherent
          }
        }
      } catch { /* malformed wtUrl → the normal dial-failure path reports it */ }
    }
    if (!boot) {
      console.warn('⚠️ No running Rust node found. Seamlessly falling back to offline mode.');
      updateHUDNode('OFFLINE', '#ff1744');
      updateHUDP2P('OFFLINE', '#ff1744');
      setNetworkRow('network-seeding-status', 'BASIC · join-only (no local node)', '#ffb300');
      return;
    }

    // Room-defaults claim gate (S2 review fix): only the DEFAULT-bootstrap
    // path — our own node's own room — may claim roomInfo owner/name
    // defaults. Imported seeds (?seed= URL, Use-link) are JOINS into someone
    // else's room and must never write defaults; see the claimRoomDefaults
    // comment in joinRoomAtEpoch for the initial-sync race this prevents.
    // pendingBootstrapOverride intentionally persists after use, so a
    // Retry-node following a seed import stays classified as a join.
    await joinRoom(boot, /* claimRoomDefaults */ !override);
  } catch (err) {
    // Review fix (T0 of #30): a join can fail AFTER the transport connected
    // (openChannel/start) — tear the half-open session down first
    // (idempotent; no-op when nothing connected) so we never sit
    // connected-but-labeled-OFFLINE. Only CURRENT-session failures reach
    // this catch (superseded joins return silently from joinRoom), so the
    // epoch bump inside leaveRoom cannot cancel a newer in-flight join.
    await leaveRoom();
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

/**
 * Join a room session (issue #30 T0): connect the transport, run the yrs
 * document handshake, and bind every per-room observer/handler against the
 * FRESH Y.Doc. Cleanly re-invokable for a DIFFERENT room after leaveRoom() —
 * T1 adapter transit is exactly leaveRoom() → joinRoom(target).
 * NetworkProvider.onEnvelope/onTick hold a single handler slot, so the
 * re-registration below replaces (never stacks) the previous room's handlers.
 */
async function joinRoom(boot: RoomBootstrap, claimRoomDefaults: boolean): Promise<void> {
  // Claim a fresh session epoch (see the sessionEpoch declaration): only the
  // newest join/leave owns the shared provider + module state.
  const epoch = ++sessionEpoch;
  try {
    await joinRoomAtEpoch(boot, epoch, claimRoomDefaults);
  } catch (err) {
    if (epoch !== sessionEpoch) {
      // Superseded mid-join: the newer session's leaveRoom yanked our
      // transport out from under us (expected). Stay silent so the failure
      // fallout can't clobber the newer session's HUD/state.
      return;
    }
    // Genuine failure of the CURRENT session — bootstrapNetworking's catch
    // tears down via leaveRoom() and renders the offline fallback.
    throw err;
  }
}

/** Body of joinRoom, bound to the epoch it claimed. After every await it
 *  re-checks the epoch and unwinds whatever it created if superseded.
 *  `claimRoomDefaults`: true only on the own-room default-bootstrap path —
 *  gates the roomInfo owner/name default writes (see below). */
async function joinRoomAtEpoch(boot: RoomBootstrap, epoch: number, claimRoomDefaults: boolean): Promise<void> {
  // 2. Connect Network link over WebTransport raw certhash (Task 3.2)
  seenPeers.clear();
  receivedTicks = 0;
  remoteLastSeen.clear();
  world.clearRemotePlayers();
  // Stable room id for per-room LOCAL state (TR2 trunk stowage keys —
  // world.ts activeRoomId). Published BEFORE the connect await (the id is
  // known synchronously) so a trunk opened during the connect window keys
  // the right room; sequential re-joins overwrite correctly. The bootstrap
  // roomId, NOT the editable display name.
  (window as any).__ssfRoomId = boot.roomId;
  updateHUDNode('ONLINE', '#00e676');
  // Connect with a cert-refresh retry on the LOCAL loopback dial: the node's WT
  // cert regenerates every launch, so a stale hash fails the handshake — on
  // failure we re-read the CURRENT cert and retry before surfacing OFFLINE.
  // Remote dials aren't retried here (their cert isn't ours to refresh — the
  // RESTRICTED? diagnostics in bootstrapNetworking own that path).
  let connectBoot = boot;
  const isLoopback = (() => {
    try { return classifyAddress(new URL(boot.wtUrl).hostname) === 'loopback'; } catch { return false; }
  })();
  let connected = false;
  for (let attempt = 0; attempt < 3 && !connected; attempt++) {
    try {
      await networkProvider.connect(connectBoot);
      connected = true;
    } catch (e) {
      if (epoch !== sessionEpoch) return; // superseded mid-connect
      if (!isLoopback || attempt === 2) throw e;
      const fp = await refreshLocalFingerprint();
      if (fp && fp.base64) {
        connectBoot = { ...connectBoot, wtUrl: `https://127.0.0.1:${fp.port}`, certHashesB64: [fp.base64] };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (epoch !== sessionEpoch) return; // superseded — the transport now belongs to the newer session
  activeBootstrap = connectBoot;
  await syncAccessPass();
  if (epoch !== sessionEpoch) return; // superseded — nothing of ours left to undo

  updateHUDP2P('CONNECTED', '#00e676');

  // Seeding readout: our own node serves on 0.0.0.0 whenever it runs —
  // every player is part of the hosting fabric unless their connection
  // blocks it. "Untested" until the self-test (or a real peer) proves it.
  const seedingFingerprint = await fetchLocalFingerprint();
  if (epoch !== sessionEpoch) return; // superseded — skip UI writes meant for this session
  if (seedingFingerprint) {
    setNetworkRow('network-seeding-status', 'SEEDING · untested — run Self-Test', '#d4a84b');
  } else {
    setNetworkRow('network-seeding-status', 'BASIC · join-only (no local node)', '#ffb300');
  }

  // 3. Initiate yrs state document handshake over Stream (Task 3.3)
  const channel = await networkProvider.openChannel('ysync');
  if (epoch !== sessionEpoch) {
    // Superseded mid-handshake — release the channel we just opened
    // (best-effort; the transport may already be torn down).
    try { await channel.writable.close(); } catch { /* superseded transport */ }
    return;
  }
  const sync = new YjsSync({
    roomId: boot.roomId,
    channel,
    ...ysyncSigner(), // Slice 2: sign outgoing + verify-before-apply on inbound
  });
  ssfDocStats.created++; // doc-lifecycle counter (see declaration)
  yjsSync = sync; // publish BEFORE start() so a concurrent leaveRoom can stop us
  await sync.start();
  if (epoch !== sessionEpoch) {
    // Superseded while the sync spun up. A concurrent leaveRoom may already
    // have stopped us (then this is a harmless double-stop); count the doc
    // as destroyed only if THIS unwind is what actually destroyed it.
    const docWasDestroyed = (sync.doc as { isDestroyed?: boolean }).isDestroyed === true;
    try { await sync.stop(); } catch { /* superseded transport */ }
    if (!docWasDestroyed && (sync.doc as { isDestroyed?: boolean }).isDestroyed) {
      ssfDocStats.destroyed++; // doc-lifecycle counter (see declaration)
    }
    if (yjsSync === sync) yjsSync = null;
    return;
  }
  // No awaits below this line — the epoch can no longer go stale mid-bind,
  // so every observer/handler below attaches to the CURRENT session's doc.

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
          // The peer JUST linked — but our opening SyncStep1 fired before the
          // dial finished and was relayed to an empty neighbor set, so the host
          // never sent its (static) room state. Re-issue SyncStep1 now that the
          // host is a live neighbor to pull the roster / room name / furniture.
          yjsSync?.resync();
        } else if (status.status === 'failed') {
          setNetworkRow('network-bridge-status', `FAILED → ${shortTarget} (see node log)`, '#ff1744');
          logToPhoneSystem(`⚠️ P2P dial to ${shortTarget}… failed: ${status.detail ?? 'unknown error'}. If both stations are behind home routers, one side needs to forward UDP 44442 on their router (the node's default pinned port; SSF_IROH_PORT overrides) or use a relay (SSF_RELAYS).`);
        }
      } catch (e) {
        console.warn('Unparseable bridge status envelope:', e);
      }
    }
  });

  // Bind shared players map (issue #20 S2): stable per-install identity in
  // the room doc. Rebinds per join like roomInfo/chat below (T0 seam) — the
  // observer attaches to the FRESH doc and our entry is re-upserted, keyed by
  // player id so a Use-link rejoin overwrites instead of duplicating.
  const playersMap = sync.doc.getMap('players');
  (window as any).__players = playersMap; // debug handle (permanent, like __setOutfit)

  // Bind the shared games map (issue #45): per-table game state (checkers
  // v1) in the room doc, keyed by game-table furniture item id. Rebinds per
  // join like players/roomInfo/chat (T0 seam) — gamesDoc attaches its
  // observer to the FRESH doc and re-notifies every subscriber (mounted game
  // UIs + the in-world board mirror in world.ts).
  bindGamesDoc(sync.doc);

  // Bind the shared furniture-layout map (issue #60 E4): keyed by furniture
  // item id, drives world.reconcileFurniture on every change (incl. the initial
  // sync burst that gives a joiner the host's arrangement). Rebinds per join
  // like players/games/roomInfo (T0 seam).
  bindFurnitureDoc(sync.doc);

  // Staged room-list (issue #60): restore + background-warm the saved passes
  // once (the node is up here), and tell the manager which room is active so
  // its pass reads CURRENT and the room we LEFT re-warms in the list.
  if (!roomPassesInited) {
    roomPassesInited = true;
    initRoomPasses({ decode: decodeBootstrapInput, resolve: resolveBridgeBootstrap });
    // Contacts (keyed identity §8): our card embeds our node reachability (the
    // same local hint passes carry) so a friend can dial us for a DM / mesh link.
    initContacts({
      myName: () => getPlayerName(),
      myHints: () => (localFingerprint ? getLocalNodeHint(localFingerprint) : null),
    });
    initDirectMessages({ resolve: resolveBridgeBootstrap, myName: () => getPlayerName() });
    // 🕸️ Mesh peer store (§7 M1): harvest every contact/friend into the durable
    // trust-weighted pool, and re-harvest whenever contacts change.
    initPeerStore({ selfPub: () => getIdentityPub() });
    harvestContactsIntoMesh();
    subscribeContacts(harvestContactsIntoMesh);
  }
  setActivePassRoom(boot.roomId);

  // Bind shared room info map updates (Task: Room Name & Room Owner)
  const roomMap = sync.doc.getMap('roomInfo');
  // Ownership-claim race guard (S2 review fix): `roomMap.has('owner')` runs
  // SYNCHRONOUSLY after sync.start(), but start() only SENDS SyncStep1 — the
  // SyncStep2 carrying the room's established state arrives async in the
  // reader loop, so the local replica is always EMPTY here. Without the
  // claimRoomDefaults gate every seed-link joiner saw "no owner", claimed
  // ownership, and reset the room name concurrently with the real values —
  // and Yjs LWW let the joiner's write win on all replicas roughly half the
  // time. Only the own-room default-bootstrap path claims now; a reload of
  // your own room re-claims the same player id (idempotent). Residual known
  // gap (pre-existing, unchanged): the OWN-room claim itself still races the
  // initial sync, so an owner who renamed their room can see the name revert
  // on reload — fixing that needs a sync-complete signal from YjsSync.
  if (claimRoomDefaults && !roomMap.has('owner')) {
    sync.doc.transact(() => {
      // S2: the owner is a player ID (stable across reloads), not a display
      // name. Legacy rooms hold 'Local-Clone' here — see isLocalPlayerRoomOwner.
      roomMap.set('owner', getPlayerId());
      roomMap.set('name', boot.roomId || 'Lobby');
    });
  }
  // E4 furniture seed (issue #60): the owner publishes the initial layout so
  // joiners converge to it — but DEFERRED past the node's initial-state sync.
  // Seeding from the empty pre-sync replica (the same seam the owner/name claim
  // above documents) re-published defaults on every owner reload and, worse,
  // resurrected peer-removed / reverted peer-moved items (review). So wait for
  // whenServerSynced, then seed ONLY if the room is genuinely empty AND we own
  // it — an already-edited room comes back non-empty and is left untouched.
  if (claimRoomDefaults) {
    const seedEpoch = epoch;
    void sync.whenServerSynced.then(() => {
      if (seedEpoch !== sessionEpoch) return; // superseded by a newer session
      if (roomMap.get('owner') === getPlayerId() && furnitureDocSize() === 0) {
        seedFurnitureDefaults();
      }
    });
  }

  // Keyed-identity Slice 1: re-assert our player entry AFTER the initial sync,
  // so our KEYED entry (keyB64 + self-cert) wins over any stale pre-Slice-1
  // entry for the same id that the node holds — the join-time upsert above runs
  // pre-sync, and Yjs LWW would otherwise keep the older keyless version.
  const entryEpoch = epoch;
  void sync.whenServerSynced.then(() => {
    if (entryEpoch === sessionEpoch) updateLocalPlayerEntry();
  });

  const updateRoomUI = () => {
    const nameVal = roomMap.get('name') as string || 'Lobby';
    const ownerVal = roomMap.get('owner') as string || 'Local-Clone';

    const nameEl = document.getElementById('room-name-display');
    const ownerEl = document.getElementById('room-owner-display');

    if (nameEl && !document.getElementById('room-name-input')) {
      nameEl.textContent = nameVal;
    }
    if (ownerEl) {
      // Owner is an id since S2 — show the display NAME via the players map.
      ownerEl.textContent = resolveOwnerLabel(ownerVal);
    }
    // #52: the ACCESS app's MY PASS room row mirrors the same doc state.
    refreshAccessRoomRow();
    // Recategorise the room list: owner (roomInfo) and the owner's pubkey (its
    // players entry) can sync in after entry, moving the current room into its
    // correct section (My Rooms / Friends' / Visited) instead of Unreached.
    renderPassesList();
    // Slice 3b: sync the advanced-chia-mesh toggle to this room's flag.
    refreshChiaModeToggle();
  };

  roomMap.observe((_event) => {
    updateRoomUI();
  });

  // Players-map changes re-render the phone roster AND the room HUD — the
  // owner's players entry can sync in after roomInfo, and name edits must
  // retitle the owner row live.
  playersMap.observe((_event) => {
    renderPhonePlayersList();
    updateRoomUI();
    harvestRoomPlayersIntoMesh(playersMap);
  });

  // Register/refresh our own entry now that the doc is bound (fires the
  // observer above, which paints the roster + HUD).
  updateLocalPlayerEntry();
  updateRoomUI();

  // Backfill retry (v0.29.7): the host's QUIESCENT room state — name, owner,
  // furniture — all ride ONE signed SyncStep2 that transfers only when the host
  // browser answers a SyncStep1 reaching it AFTER the P2P link is up. But the
  // opening SyncStep1 (start()) races the node's dial and is relayed to an empty
  // neighbor set, and the resync-on-'connected' above can be swallowed when a
  // background prefetch already claimed the node's shared dial single-flight (so
  // this session never receives a 'connected' status). Result: movement ticks
  // flow (separate unsigned lane) but the room shows "Lobby" with no furniture
  // forever. Re-issue SyncStep1 on a bounded cadence until the host's roomInfo
  // lands (owner present), then stop. A room we OWN already set its own owner
  // via claimRoomDefaults, so this no-ops there. Verified: a single post-link
  // resync pulls the full roomInfo/players/furniture SyncStep2.
  if (!claimRoomDefaults) {
    const backfillEpoch = epoch;
    const backfillDeadline = performance.now() + 30_000;
    const backfillTick = () => {
      if (backfillEpoch !== sessionEpoch) return; // superseded by a newer join
      if (roomMap.has('owner')) return;           // host state arrived — done
      if (performance.now() >= backfillDeadline) return;
      yjsSync?.resync();
      window.setTimeout(backfillTick, 2_000);
    };
    window.setTimeout(backfillTick, 1_500);
  }

  // Bind shared chat array updates to SpacePhone interface (Task Task 3.3/4.1)
  const sharedChat = sync.doc.getArray('chat');
  const rebuildChatLog = () => {
    // Re-populate our scroll container whenever sync modifications occur
    const container = document.getElementById('chat-messages-container');
    if (container) {
      // Safe clear except original system greet is fine
      container.innerHTML = `<div class="chat-bubble system">📲 SpacePhone connection ready. Welcome to Furlong System Net!</div>`;
      const items: any[] = sharedChat.toArray();
      items.forEach(item => {
        // S2: classify by stable authorId. Pre-S2 messages carry no authorId
        // and EVERY pre-S2 sender wrote the literal authorName 'Local-Clone',
        // so the fallback renders all legacy messages as 'me' — exactly the
        // pre-S2 behavior (no regression, no improvement). The 2+ player
        // me/them fix only applies to messages written with an authorId.
        const isMe = typeof item.authorId === 'string'
          ? item.authorId === getPlayerId()
          : item.authorName === 'Local-Clone';
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
  };
  sharedChat.observe((_event) => {
    rebuildChatLog();
  });
  // Rejoin fix (issue #30 T0): after leaveRoom()→joinRoom() the container
  // still renders the PREVIOUS room's log, and an empty new room never fires
  // the observer. Rebuild once from the fresh doc now — on a first join this
  // is a visual no-op (empty array → the same system greeting the container
  // already holds in index.html). Accepted: this also wipes any PRE-join
  // logToPhoneSystem() lines — rebind semantics; the log mirrors the doc.
  rebuildChatLog();

  // 4. Set up incoming real-time client movement tick handler.
  // 0.23.0 wire (issue #22): the node prefixes every delivered tick with the
  // sender's 8-byte lane id ([8B sender][13B tick]) so each remote player
  // keys to a stable identity instead of aliasing into `peer-${seq % 4}`.
  networkProvider.onTick((buf) => {
    try {
      let peerId: string;
      let tick: MovementTick;
      if (buf.byteLength === ADDRESSED_TICK_BYTES) {
        const addressed = unpackAddressedTick(buf);
        peerId = `peer-${addressed.senderId}`;
        tick = addressed.tick;
      } else if (buf.byteLength === TICK_BYTES) {
        // Legacy un-addressed tick (pre-0.23.0 node or embedded fallback
        // listener): no sender identity on the wire — collapse into one slot
        // rather than fabricate ids from the seq counter.
        peerId = 'peer-legacy';
        tick = unpackTick(buf);
      } else {
        return; // unknown datagram framing — ignore
      }
      seenPeers.add(peerId);
      receivedTicks++;
      remoteLastSeen.set(peerId, performance.now());
      world.updateRemotePlayer(peerId, tick.x, tick.z, (tick.flags & 1) === 1, (tick.flags & 2) === 2, tick.yaw);
    } catch (e) {
      console.warn('Error unpacking incoming remote peer datagram tick:', e);
    }
  });
}

/**
 * Tear down the active room session (issue #30 T0): stop the yrs sync —
 * closing its writer and DESTROYING the Y.Doc (the pre-T0 leak: rejoin used
 * to abandon the old doc with its observers still attached) — then drop the
 * transport. Safe to call when nothing is connected.
 * `activeBootstrap` intentionally survives as last-room memory: Retry-node
 * re-derives the same roomId/roomKey from it via fetchDefaultBootstrap, and
 * the bootstrap error path reports the last attempted seed.
 */
async function leaveRoom(): Promise<void> {
  // Invalidate any in-flight joinRoom (see the sessionEpoch declaration).
  sessionEpoch++;
  // We are now roomless (issue #60 review): clear the active-pass room so a
  // swap that leaves but never re-joins (stranded) can't wedge a pass showing
  // YOU-ARE-HERE with no way to re-enter. A successful join re-sets it; the
  // room we left re-warms so it stays enterable from the list.
  setActivePassRoom(null);
  // Claim the sync ref BEFORE awaiting so overlapping leaveRoom calls can't
  // double-stop (and double-count) the same session.
  const sync = yjsSync;
  yjsSync = null;
  if (sync) {
    const oldDoc = sync.doc;
    try {
      await sync.stop(); // closes the ysync writer + doc.destroy()
    } catch (err) {
      console.warn('Error stopping yjs room sync:', err);
    }
    if ((oldDoc as { isDestroyed?: boolean }).isDestroyed) {
      ssfDocStats.destroyed++; // doc-lifecycle counter (see declaration)
    } else {
      console.warn('leaveRoom: previous Y.Doc was not destroyed by stop()');
    }
  }
  try {
    await networkProvider.disconnect();
  } catch (err) {
    console.warn('Error disconnecting prior network link:', err);
  }
}

// ── Adapter transit (T1 of issue #30) ─────────────────────────────────────────

/** Full-screen fade curtain covering the room swap (#welcome overlay
 *  pattern: opacity transition on a fixed DOM layer). Lazily created. */
let transitFadeEl: HTMLDivElement | null = null;
const TRANSIT_FADE_MS = 400;
/** Hard cap on the leave→join swap (review fix F3) — generous against the
 *  same-node ~100-300 ms swap; T2's cross-node arrival gate supersedes it. */
const SWAP_WATCHDOG_MS = 15_000;
/** Issue #60 (P1.3): how long the transit curtain waits, AFTER the join, for
 *  the host's room state (roomInfo owner+name) to arrive over the mesh before
 *  entering anyway. A joiner's local node starts with an empty replica; the
 *  host's owner/name land as bridged Yjs updates once the peer dial connects,
 *  so without this the avatar was staged painting default Lobby/Local-Clone
 *  values. On timeout we enter with defaults, which the roomInfo observer
 *  (main.ts ~577) repaints live the moment the real state does arrive. */
const SYNC_GATE_MS = 8_000;

/**
 * Resolve once the freshly-joined room's shared state has converged — the
 * host's roomInfo `owner` AND `name` keys are present — or after `timeoutMs`
 * as a fallback (issue #60 P1.3). Observes the CURRENT session's doc captured
 * at call time; if a newer session/leave destroys it mid-wait, the timeout
 * still resolves so the curtain never wedges.
 */
function awaitInitialRoomState(timeoutMs: number): Promise<void> {
  const sync = yjsSync;
  if (!sync) return Promise.resolve();
  const roomMap = sync.doc.getMap('roomInfo');
  const ready = () => roomMap.has('owner') && roomMap.has('name');
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const observer = () => { if (ready()) finish(); };
    const finish = () => {
      if (done) return;
      done = true;
      try { roomMap.unobserve(observer); } catch { /* doc may be destroyed */ }
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    roomMap.observe(observer);
    // Guard the race between the initial ready() check and observe() attaching.
    if (ready()) finish();
  });
}

/** Ease the transit curtain to fully opaque (true) or clear (false).
 *  Resolves after the transition duration (timer, not transitionend — the
 *  event is droppable when the tab is backgrounded mid-transit). */
function transitFadeTo(opaque: boolean): Promise<void> {
  if (!transitFadeEl) {
    transitFadeEl = document.createElement('div');
    transitFadeEl.id = 'transit-fade';
    transitFadeEl.style.cssText = `
      position: fixed;
      inset: 0;
      background: #01020a;
      opacity: 0;
      pointer-events: none;
      transition: opacity ${TRANSIT_FADE_MS}ms ease;
      z-index: 8500;
    `;
    document.body.appendChild(transitFadeEl);
    // Flush the initial style so the very first opacity write transitions.
    void transitFadeEl.offsetHeight;
  }
  const el = transitFadeEl;
  // Swallow clicks while covered (nothing behind the curtain is clickable).
  el.style.pointerEvents = opaque ? 'auto' : 'none';
  el.style.opacity = opaque ? '1' : '0';
  return new Promise((resolve) => window.setTimeout(resolve, TRANSIT_FADE_MS + 50));
}

/** Outcome of a curtain-covered room swap: 'ok', 'busy' (another swap holds
 *  the transit latch — nothing happened), or the failure that was recovered
 *  from (the original room was restored, or torn down to offline when even
 *  the restore failed). */
type RoomSwapResult = 'ok' | 'busy' | Error;

/** A swap failure that ALSO left us with no room at all (the pass was used
 *  before the first join completed, or the departure-room rejoin failed):
 *  the HUD shows OFFLINE and callers must not claim "returned to your room". */
class StrandedOfflineError extends Error {}

/** Per-caller choreography hooks for performRoomSwap. Both run while the
 *  transit curtain is fully opaque. */
interface RoomSwapChoreography {
  /** Arrival — the target room's session is live; stage the avatar (the T1
   *  transit walks in through the arrival door, the #52 ACCESS beam-in
   *  simply places the avatar at the default spawn). */
  arrive: () => void;
  /** Failure — the original room has been restored (or torn down). The T1
   *  transit lights the vestibule 'fault' and walks back in; the beam-in has
   *  nothing to restage (the avatar never moved). */
  fail: () => void;
}

/**
 * The curtain-covered room swap shared by the T1 adapter transit (#30) and
 * the #52 ACCESS-app pass transport. Rides entirely on the T0 seam:
 *   decode seed → fade in → leaveRoom() → joinRoom(target) → arrival
 *   choreography → fade out.
 * On ANY failure the original room is rejoined (bootstrap snapshot taken
 * before leaving) and the failure choreography runs — the fade covers both
 * directions. One swap at a time (transitInProgress latch).
 */
async function performRoomSwap(seedString: string, choreography: RoomSwapChoreography): Promise<RoomSwapResult> {
  if (transitInProgress) return 'busy';
  transitInProgress = true;
  // Snapshot BEFORE leaving: leaveRoom keeps activeBootstrap as last-room
  // memory, but joinRoom(target) overwrites it — this is the way back.
  const originalBoot = activeBootstrap;
  let leftOriginalRoom = false;
  try {
    const imported = decodeBootstrapInput(seedString);
    if (!imported) {
      throw new Error('Unreadable room seed');
    }
    const target = await resolveBridgeBootstrap(imported);
    // Rooms WE minted this session (PROVISION NEW MODULE) are first-entries
    // into a fresh unowned room — claim the defaults; everything else joins.
    const claiming = mintedRoomIds.has(target.roomId);
    await transitFadeTo(true);
    // Swap watchdog (review fix F3): a stalled leave/join would otherwise
    // hold the opaque curtain forever with all input dead. The timeout
    // throws into the catch below, whose recovery path already handles a
    // half-open session (leaveRoom bumps the epoch, so the still-in-flight
    // join unwinds silently through the T0 epoch guard when it resolves).
    const swapPromise = (async () => {
      await leaveRoom();
      leftOriginalRoom = true;
      await joinRoom(target, /* claimRoomDefaults */ claiming);
    })();
    // Detached-rejection guard: if the watchdog wins the race, the late swap
    // rejection must not surface as an unhandled-rejection console error.
    swapPromise.catch(() => { /* reported through the race */ });
    let watchdogId = 0;
    try {
      await Promise.race([
        swapPromise,
        new Promise<never>((_, reject) => {
          watchdogId = window.setTimeout(
            () => reject(new Error(`Dock swap watchdog: no arrival within ${SWAP_WATCHDOG_MS / 1000} s`)),
            SWAP_WATCHDOG_MS,
          );
        }),
      ]);
    } finally {
      window.clearTimeout(watchdogId);
    }
    // Review fix F2: only the FIRST entry into a room we minted claims its
    // defaults — from now on re-entering it is a plain join, so a rename
    // made in that room survives later visits (the pre-sync !has('owner')
    // claim guard always passes on an empty replica and would re-reset it).
    if (claiming) mintedRoomIds.delete(target.roomId);
    // Review fix F1: classify every future Retry-node reconnect as a JOIN —
    // bootstrapNetworking claims defaults only when this override is null,
    // and after a transit the current room is never a first-entry: foreign
    // rooms were never ours to claim, and a just-claimed minted room already
    // has its owner written (a re-claim would race the initial sync and
    // steal/reset owner+name — the exact S2 bug the claim gate exists for).
    pendingBootstrapOverride = target;
    // Issue #60 (P1.3): hold the curtain until the host's room state has synced
    // (or the bounded fallback) so the avatar isn't staged in a room still
    // showing the default name/owner (symptoms 1 & 5). Only foreign joins
    // actually wait — a minted/own room already has owner+name written, and a
    // same-node transit's replica is already populated, so both resolve at once.
    await awaitInitialRoomState(SYNC_GATE_MS);
    // Stage the avatar behind the opaque curtain.
    choreography.arrive();
    await transitFadeTo(false);
    return 'ok';
  } catch (err) {
    console.warn('Room swap failed — restoring the departure room:', err);
    await transitFadeTo(true); // no-op visually if already opaque
    let stranded = false;
    if (leftOriginalRoom) {
      // Tear down whatever half-open session the failed join left behind
      // (idempotent), then re-dock to the original room — local and fast.
      await leaveRoom();
      if (originalBoot) {
        try {
          await joinRoom(originalBoot, /* claimRoomDefaults */ false);
        } catch (rejoinErr) {
          console.warn('Could not rejoin the departure room after a failed transit:', rejoinErr);
          await leaveRoom();
          updateHUDNode('OFFLINE', '#ff1744');
          updateHUDP2P('OFFLINE', '#ff1744');
          stranded = true;
        }
      } else {
        // No departure room existed (pass used before the first join
        // completed / bootstrap never succeeded) — we are genuinely roomless
        // now; say so on the HUD instead of pretending a restore happened.
        updateHUDNode('OFFLINE', '#ff1744');
        updateHUDP2P('OFFLINE', '#ff1744');
        stranded = true;
      }
    }
    choreography.fail();
    await transitFadeTo(false);
    const failure = err instanceof Error ? err : new Error(String(err));
    return stranded ? new StrandedOfflineError(failure.message) : failure;
  } finally {
    transitInProgress = false;
  }
}

/**
 * The adapter transit (T1 of #30), invoked by the World when the avatar
 * reaches the vestibule hold point (mid ADAPTER_HOLD): the shared room swap
 * with door choreography on both ends — reposition at the arrival door and
 * scripted walk-in on success; vestibule 'fault' lights and a walk back in
 * through the departure door on failure. A busy latch stays silent (the
 * door machine falls through to the peek round-trip — review fix F4).
 */
async function transitTo(seedString: string, departureDoorId: DoorId): Promise<void> {
  const result = await performRoomSwap(seedString, {
    arrive: () => world.completeAdapterArrival(departureDoorId),
    fail: () => world.failAdapterTransit(departureDoorId),
  });
  if (result instanceof Error) showHint('Dock seal failed.');
}

/**
 * ACCESS-app pass acceptance (#52). Dev-phase ruling: using a pass
 * IMMEDIATELY TRANSPORTS the player — the same curtain-covered swap as the
 * adapter transit but with no door walk on either side: on arrival the
 * avatar is simply placed at the room's default spawn in MANUAL control (a
 * "beam-in"). On failure the original room is restored and the avatar stays
 * exactly where it was.
 * FUTURE (map slice): once the map table carries room pins, a used pass will
 * instead drop a pin at the room's location on the map with the access
 * permission attached — travel then goes through the map/doors, and this
 * instant beam retires with the dev phase.
 */
async function accessBeamTransport(seedString: string): Promise<RoomSwapResult> {
  return performRoomSwap(seedString, {
    arrive: () => world.completeAccessBeamIn(),
    fail: () => { /* the avatar never left the origin room — nothing to restage */ },
  });
}

/**
 * Wire the adapter-transit choreography once the world's docking system
 * exists (called right after startMorph builds the platform): the swap
 * driver on the World, and the module-minting callback on the docking pane
 * (docking.ts never imports main.ts — existing callback-wiring pattern).
 */
function wireAdapterTransit(): void {
  world.onAdapterTransit = (seed, departureDoorId) => {
    void transitTo(seed, departureDoorId);
  };
  // Review fix F4: expose the transit latch so a door click during an
  // in-flight swap falls through to the normal peek round-trip instead of
  // spawning a vestibule whose transit would silently early-return.
  world.isTransitBusy = () => transitInProgress;
  const provisionModuleSeed = async (): Promise<string | null> => {
    const bytes = new Uint8Array(3);
    crypto.getRandomValues(bytes);
    const roomId = `module-${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const minted = await mintBootstrapLink(undefined, roomId);
    if (!minted.link) return null;
    mintedRoomIds.add(roomId);
    return minted.link;
  };
  world.dockingSystem?.onProvisionModule(provisionModuleSeed);
  // DEV1 dev-menu hook: the MODULES row self-enables when this handle exists.
  (window as any).__ssfProvisionModule = provisionModuleSeed;
}

// ── Player identity in the room doc (issue #20 S2) ───────────────────────────

/** Shape of a `players` map entry. Plain JSON — no Y types nested inside. */
interface PlayerEntry {
  name: string;
  joinedAt: number;
  outfitId: string;
  /** Keyed-identity Slice 1 (additive): the player's Ed25519 public key
   *  (base64url) and a self-signature over the name↔key binding. Lets a peer
   *  verify a display name is backed by a real key (verifyNameCert). The map
   *  is still KEYED by the legacy UUID (getPlayerId) — the pubkey-as-id
   *  migration is a later, dual-read slice. Optional so legacy entries stay
   *  valid. */
  keyB64?: string;
  keySig?: string;
}

/**
 * Upsert OUR entry in the current room doc's `players` map. Keyed by the
 * per-install player id, so a leave→rejoin overwrites in place (no duplicate
 * entries) and `joinedAt` is preserved from the existing entry when present.
 * Safe to call any time (no-op offline); the name editor and the outfit
 * switcher both funnel through here so the doc always mirrors local state.
 */
function updateLocalPlayerEntry(): void {
  const sync = yjsSync;
  if (!sync) return;
  const players = sync.doc.getMap('players');
  const id = getPlayerId();
  const prev = players.get(id) as Partial<PlayerEntry> | undefined;
  const name = getPlayerName();
  const entry: PlayerEntry = {
    name,
    joinedAt: typeof prev?.joinedAt === 'number' ? prev.joinedAt : Date.now(),
    outfitId: loadSavedOutfitId() ?? 'default',
    // Self-signed name↔key cert (Slice 1): proves the identity key holder
    // claims this name. Re-signed on every upsert so a name edit re-certs.
    keyB64: getIdentityPub(),
    keySig: signNameCert(name),
  };
  sync.doc.transact(() => {
    players.set(id, entry);
  });
}

/**
 * Resolve a `roomInfo.owner` value to a display label. Owners are player ids
 * as of S2 — resolve the NAME through the players map when the entry exists.
 * Legacy docs store the literal 'Local-Clone' (shown as-is); an id with no
 * players entry yet renders shortened rather than as a full UUID.
 */
function resolveOwnerLabel(owner: string): string {
  const entry = yjsSync?.doc.getMap('players').get(owner) as Partial<PlayerEntry> | undefined;
  if (entry && typeof entry.name === 'string' && entry.name) {
    return entry.name;
  }
  return owner.length > 16 ? `${owner.slice(0, 8)}…` : owner;
}

/** True when WE may edit the room name: owner is our player id, or the room
 *  predates S2 (legacy 'Local-Clone' owner — those rooms stay editable). */
function isLocalPlayerRoomOwner(owner: string): boolean {
  return owner === getPlayerId() || owner === 'Local-Clone';
}

/**
 * Render the 'CLONES SEEN' roster on the phone home screen from the current
 * doc's `players` map. Called from the per-join players observer and on
 * phone setup (offline placeholder). DOM built via textContent — names are
 * remote-controlled strings and must never hit innerHTML.
 *
 * 'SEEN', not 'IN ROOM': nothing ever REMOVES a players entry in S2 (no
 * leave hook, no liveness), so departed players stay listed until S3
 * presence lands heartbeat/lastSeen semantics.
 *
 * v1 scope note (S2): this list IS the visual surface for the players map.
 * Name tags over remote rigs and outfit application on remote rigs are
 * deferred to S3 — the tick lane keys peers by per-connection lane id and
 * there is no lane-id → player-id mapping yet, so any rig↔entry pairing here
 * would be a guess for 2+ remote players.
 */
function renderPhonePlayersList(): void {
  const countEl = document.getElementById('phone-players-count');
  const listEl = document.getElementById('phone-players-list');
  if (!countEl || !listEl) return;
  listEl.textContent = '';

  const sync = yjsSync;
  if (!sync) {
    countEl.textContent = '--';
    const offline = document.createElement('li');
    offline.className = 'phone-players-empty';
    offline.textContent = 'OFFLINE · no room link';
    listEl.appendChild(offline);
    return;
  }

  const players = sync.doc.getMap('players');
  const rows: Array<{ id: string; entry: Partial<PlayerEntry> }> = [];
  players.forEach((value, key) => {
    if (value && typeof value === 'object') {
      rows.push({ id: key, entry: value as Partial<PlayerEntry> });
    }
  });
  rows.sort((a, b) => (a.entry.joinedAt ?? 0) - (b.entry.joinedAt ?? 0));

  countEl.textContent = String(rows.length);
  const myId = getPlayerId();
  for (const { id, entry } of rows) {
    const li = document.createElement('li');
    li.className = 'phone-players-row';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'phone-players-name';
    nameSpan.textContent = (entry.name || 'Unknown-Clone') + (id === myId ? ' (you)' : '');
    const sinceSpan = document.createElement('span');
    sinceSpan.className = 'phone-players-since';
    sinceSpan.textContent = typeof entry.joinedAt === 'number'
      ? new Date(entry.joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '--:--';
    li.appendChild(nameSpan);
    li.appendChild(sinceSpan);
    listEl.appendChild(li);
  }
}

function setupSpacePhoneOverlay() {
  // bootstrapNetworking() re-runs via the Retry-node / Use-link buttons;
  // guard so the Tab toggle and form submit listeners bind exactly once
  // (same pattern as networkPanelInitialized).
  if (phoneOverlayInitialized) return;
  phoneOverlayInitialized = true;

  const container = document.getElementById('spacephone-container');
  const chatInput = document.getElementById('chat-input') as HTMLInputElement;
  const chatForm = document.getElementById('chat-form');
  const tipIndicator = document.getElementById('phone-tip-indicator');

  // 📱 Phone shell view router (issue #20 S1) — home screen + per-app views.
  // Policy: Tab always opens the phone to the HOME screen (deterministic,
  // one tap to any app) rather than restoring the last open view.
  type PhoneViewId = 'home' | 'chat' | 'contacts' | 'bank' | 'access';
  const phoneViewMeta: Record<PhoneViewId, { elId: string; title: string; subtitle: string }> = {
    home:     { elId: 'phone-home-screen',   title: '📱 HOME',        subtitle: 'FurlongOS · Select App' },
    chat:     { elId: 'phone-app-chat',      title: '👨‍🚀 CLONE CHAT', subtitle: 'Room: Furlong Lobby' },
    contacts: { elId: 'phone-app-contacts',  title: '👥 CONTACTS',    subtitle: 'FurlongNet Directory' },
    bank:     { elId: 'phone-app-bank',      title: '🏦 BANK',        subtitle: 'Furlong Credit Union' },
    access:   { elId: 'phone-app-access',    title: '🚪 ACCESS',      subtitle: 'Room Passes · FurlongNet' },
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
    // ACCESS (#52): MY PASS shows the CURRENT room — repaint on every open
    // (the per-join observers keep it live afterwards; this covers the
    // offline/pre-join state and the first open).
    if (id === 'access') refreshAccessRoomRow();
    if (id === 'contacts') refreshContactsApp();
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
  // we exclude via the non-chat input guard below. Guard on e.target — not
  // document.activeElement — because the editor's Escape branch replaceWith()s
  // the focused input before the event bubbles here, leaving activeElement
  // pointing at <body>; e.target stays the original input.)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!container || !container.classList.contains('active')) return;
    const target = e.target as HTMLElement | null;
    if (
      target && target !== chatInput &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
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
        // Don't let Tab OPEN the SpacePhone while editing the room: an open
        // phone latches the #spacephone-container.active guard that swallows the
        // edit-mode ESC handler (editMode.ts) AND the +/- first-person keys
        // (zoom.ts), stranding the player in edit mode with no working exit.
        // Tab may still CLOSE an already-open phone.
        if (roomEdit.isEditModeActive() && !container.classList.contains('active')) return;
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

  // 🧑‍🚀 Identity row (issue #20 S2): 'YOU: <name> [edit]' on the home screen.
  // Clicking the name (or ✎) swaps it for an inline input — Enter/blur saves
  // via setPlayerName and pushes the change into the room doc's players map;
  // Escape cancels (the phone's own Escape-to-home handler above already
  // ignores keydowns targeted at non-chat inputs, same as the room-name editor).
  const playerNameEl = document.getElementById('phone-player-name');
  const playerNameEditBtn = document.getElementById('phone-player-name-edit');
  const refreshIdentityRow = () => {
    if (playerNameEl) playerNameEl.textContent = getPlayerName();
    const keyEl = document.getElementById('phone-identity-key');
    if (keyEl) {
      keyEl.textContent = `🔑 ${getIdentityFingerprint()}`;
      keyEl.title = `Cryptographic identity (keyed-identity): ${getIdentityPub()}`;
    }
  };
  refreshIdentityRow();
  const beginPlayerNameEdit = () => {
    if (!playerNameEl || document.getElementById('phone-player-name-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'phone-player-name-input';
    input.value = getPlayerName();
    input.maxLength = PLAYER_NAME_MAX_LENGTH;
    playerNameEl.replaceWith(input);
    input.focus();
    input.select();
    let finished = false; // guards the Enter→blur double-fire
    const closeEditor = (save: boolean) => {
      if (finished) return;
      finished = true;
      if (save) setPlayerName(input.value); // blank input → name unchanged
      input.replaceWith(playerNameEl);
      refreshIdentityRow();
      if (save) updateLocalPlayerEntry(); // mirror into the room doc (no-op offline)
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        closeEditor(true);
      } else if (ev.key === 'Escape') {
        closeEditor(false);
      }
    });
    input.addEventListener('blur', () => closeEditor(true));
  };
  playerNameEl?.addEventListener('click', beginPlayerNameEdit);
  playerNameEditBtn?.addEventListener('click', beginPlayerNameEdit);

  // Roster section starts in the offline placeholder state; the per-join
  // players-map observer repaints it once a doc is bound.
  renderPhonePlayersList();

  // ── 🚪 ACCESS app (#52) — room passes ───────────────────────────────────────
  // MY PASS: mint an invite for the current room (the network panel's old
  // Copy Invite pipeline, R1 pre-flight warning included) and copy it.
  // ENTER WITH PASS: accept a pass — dev-phase ruling: instant transport.
  const accessGenerateBtn = document.getElementById('access-generate-btn');
  const accessOutput = document.getElementById('access-pass-output') as HTMLInputElement | null;
  const accessInput = document.getElementById('access-pass-input') as HTMLInputElement | null;
  const accessUseBtn = document.getElementById('access-use-btn');
  const setAccessFeedback = (msg: string) => {
    const el = document.getElementById('access-feedback');
    if (el) el.textContent = msg;
  };

  if (accessGenerateBtn) {
    accessGenerateBtn.addEventListener('click', async () => {
      const minted = await mintBootstrapLink();
      if (!minted.link) {
        setAccessFeedback(minted.error ?? 'Pass is not available yet.');
        return;
      }
      if (accessOutput) accessOutput.value = minted.link;
      const warning = inviteReachabilityWarning(minted.boot);
      try {
        await navigator.clipboard.writeText(minted.link);
        setAccessFeedback(warning
          ? `Pass copied. ${warning}`
          : 'Pass copied. Share this one pass with everyone.');
      } catch {
        setAccessFeedback(warning
          ? `Pass ready above (clipboard permission was denied). ${warning}`
          : 'Pass ready above. Clipboard permission was denied.');
      }
    });
  }

  // ADD PASS (issue #60 staged room-list): a pasted pass is ADDED to MY ROOMS
  // and warmed in the background — it no longer beams you mid-connect. You
  // enter from the list once the room reads READY.
  if (accessUseBtn && accessInput) {
    accessUseBtn.addEventListener('click', () => {
      const raw = accessInput.value.trim();
      if (!raw) {
        setAccessFeedback('Paste a pass first.');
        return;
      }
      const result = addPass(raw);
      if (!result.ok) {
        setAccessFeedback(result.error);
        return;
      }
      accessInput.value = '';
      // Streamlined "join now": pasting a pass IS a request to enter that room,
      // so arm an auto-enter — we still wait for it to warm to READY (the
      // sync-before-enter gate, #60) before swapping, so you never land in a
      // half-loaded room, but you no longer have to notice + click ENTER.
      autoEnterRoomId = result.roomId;
      setAccessFeedback(
        `🛰️ Connecting to that room — you'll be taken in automatically once it's ready. ` +
        `A first cross-internet connect can take up to ~30s.`,
      );
    });
  }

  renderPassesList();
  subscribePasses(renderPassesList);
  // Re-categorise rooms when the friends list changes (a room's owner moving
  // in/out of Friends flips it between the FRIENDS' ROOMS and VISITED sections).
  subscribeContacts(renderPassesList);

  // Auto-enter driver: when the just-added pass finishes warming, take the user
  // in (and close the phone so the room is right there). OFFLINE surfaces a
  // clear, non-destructive message — the pass stays saved for a manual retry.
  subscribePasses(() => {
    if (!autoEnterRoomId) return;
    const rid = autoEnterRoomId;
    const state = passState(rid);
    if (state === 'ready') {
      autoEnterRoomId = null;
      const seed = passSeed(rid);
      if (seed) {
        container?.classList.remove('active');
        void enterRoomFromPass(seed);
      }
    } else if (state === 'offline') {
      autoEnterRoomId = null;
      setAccessFeedback(
        `Couldn't reach that room yet — it may be offline or still hole-punching. ` +
        `It's saved in your list; tap ENTER to retry.`,
      );
    } else if (state === 'current') {
      autoEnterRoomId = null; // already there
    }
  });

  // Room access mode selector (public-doors): owner sets PUBLIC/PASS/KEYED;
  // the roomInfo observer repaints it live for everyone (setRoomAccessMode is
  // owner-gated, so a non-owner click is inert).
  const accessModeRow = document.getElementById('access-mode-row');
  if (accessModeRow) {
    accessModeRow.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.access-mode-btn');
      if (!btn || btn.disabled) return;
      setRoomAccessMode(btn.dataset.accessMode as AccessMode);
      applyAccessModeUI(getRoomAccessMode());
    });
  }

  // 👥 Contacts app wiring (keyed identity §8) — share/import cards, friends.
  setupContactsApp();

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
            // S2: authorId is the stable identity (isMe check); authorName is
            // denormalized for display + legacy readers.
            authorId: getPlayerId(),
            authorName: getPlayerName(),
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
  return refreshLocalFingerprint();
}

/** R1: bypass the cache and re-read the node's fingerprint, updating the
 *  cached copy and the REACHABILITY row. Reachability and direct-addr hints
 *  change minutes after node startup (echo loop, portmapper mapping), so the
 *  panel re-polls this on an interval — a one-shot startup snapshot would
 *  pin the row (and freshly-minted invite hints) to a stale state. */
async function refreshLocalFingerprint(): Promise<LocalFingerprint | null> {
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
    // Node unreachable this round: keep the last-known fingerprint (if any)
    // rather than blanking live sessions; the row shows NO NODE when we have
    // never seen one.
    renderReachabilityRow(localFingerprint);
    return localFingerprint;
  }
  fingerprint.iroh_relay_urls = normalizeStringArray(fingerprint.iroh_relay_urls);
  fingerprint.iroh_direct_addrs = normalizeStringArray(fingerprint.iroh_direct_addrs);
  localFingerprint = fingerprint;
  renderReachabilityRow(fingerprint);
  return fingerprint;
}

/** Wait for the local node to be reachable, RE-READING a fresh fingerprint each
 *  attempt. The node sidecar can take a second or two to bind after the app
 *  launches, and its WebTransport cert is regenerated on every node launch — so
 *  a cached/stale hash would fail the loopback handshake. Without this retry a
 *  startup race between the WebView and the node dropped us straight to NODE
 *  OFFLINE with no recovery (the recurring "node offline" on launch). */
async function awaitLocalNodeFingerprint(attempts = 12, delayMs = 600): Promise<LocalFingerprint | null> {
  for (let i = 0; i < attempts; i++) {
    const fp = await refreshLocalFingerprint();
    if (fp && fp.base64) return fp;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

async function fetchDefaultBootstrap(): Promise<RoomBootstrap | null> {
  const fingerprint = await awaitLocalNodeFingerprint();
  if (!fingerprint) {
    return null;
  }
  const roomId = activeBootstrap?.roomId ?? getDefaultRoomId();
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

function buildOutgoingBootstrap(parsedWtUrl: string, fingerprint: LocalFingerprint, roomIdOverride?: string): RoomBootstrap {
  // roomIdOverride (T1 of #30): mint against a FRESH room on our own node
  // (PROVISION NEW MODULE) instead of the currently-joined room. The room key
  // is minted+persisted per roomId, so re-provisioning the same id (never
  // happens — ids are random) or later rejoining reuses the same key.
  const roomId = roomIdOverride ?? activeBootstrap?.roomId ?? getDefaultRoomId();
  const roomKeyB64 = roomIdOverride
    ? getOrCreateRoomKeyB64(roomId)
    : activeBootstrap?.roomKeyB64 ?? getOrCreateRoomKeyB64(roomId);

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

async function mintBootstrapLink(rawAddress?: string, roomIdOverride?: string): Promise<{ link?: string; error?: string; scope?: ReturnType<typeof classifyAddress>; boot?: RoomBootstrap }> {
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

  const boot = buildOutgoingBootstrap(wtUrl, fingerprint, roomIdOverride);
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
    // R1: the minted bootstrap rides along so callers (Copy Invite pre-flight)
    // can inspect the ACTUAL outgoing hints instead of re-deriving them.
    boot,
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

  const roomId = imported.roomId || localBoot.roomId || getDefaultRoomId();
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

// ChiaHub Slice 3b: reflect the CURRENT room's advanced-chia-mesh flag on the
// management-computer toggle (network-details panel). Called on room changes and
// panel setup. The flag is per-room in localStorage (`ssf-chia-mode-<roomId>`),
// matching how NetworkProvider reads it at connect and the node stores it per-room.
function refreshChiaModeToggle() {
  const toggle = document.getElementById('chia-mode-toggle') as HTMLInputElement | null;
  const state = document.getElementById('chia-mode-state');
  if (!toggle) return;
  const roomId = (window as unknown as { __ssfRoomId?: string }).__ssfRoomId;
  let on = false;
  if (roomId) {
    try { on = localStorage.getItem(`ssf-chia-mode-${roomId}`) === '1'; } catch { /* privacy mode */ }
  }
  toggle.checked = on;
  toggle.disabled = !roomId; // no room context yet -> nothing to toggle
  if (state) state.textContent = on ? 'ON' : 'OFF';
}

function setupNetworkDetailsPanel() {
  if (networkPanelInitialized) return;
  networkPanelInitialized = true;

  // #52: the invite mint (Copy Invite) and accept (Use Link) widgets MOVED
  // to the SpacePhone ACCESS app — this panel keeps diagnostics, node status
  // and the reachability rows only (plus a thin moved-note pointer).
  const panel = document.getElementById('network-details-hud');
  const toggle = document.getElementById('network-details-toggle');
  const retryBtn = document.getElementById('network-retry-node-btn');
  const feedback = document.getElementById('network-link-feedback');

  if (retryBtn) {
    retryBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Review fix F5: the transit curtain blocks pointer events but not
      // keyboard activation (Enter on a focused button) — a concurrent
      // leave/join here would leave the transit's arrival choreography
      // running against the wrong live session.
      if (transitInProgress) {
        if (feedback) feedback.textContent = 'Adapter transit in progress — try again in a moment.';
        return;
      }
      localFingerprint = null;
      if (feedback) feedback.textContent = 'Retrying local node handshake...';
      // Full session teardown (issue #30 T0): stop the old YjsSync (destroys
      // its Y.Doc) before reconnecting, instead of a bare disconnect().
      await leaveRoom();
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
            // S2 gate: owner is our player id, or a legacy pre-S2 room
            // ('Local-Clone' owner) — those stay editable by everyone.
            if (isLocalPlayerRoomOwner(ownerVal)) {
              yjsSync.doc.transact(() => {
                rMap.set('name', newVal);
              });
            } else {
              if (feedback) feedback.textContent = `Only the owner (${resolveOwnerLabel(ownerVal)}) can edit the room name.`;
              setTimeout(() => { if (feedback) feedback.textContent = ''; }, 4000);
            }
          } else {
            nameEl.textContent = newVal;
          }
        }
        input.replaceWith(nameEl);
        // Repaint from the doc: the roomInfo observer fired INSIDE the
        // transact above, while the editor input was still mounted — and
        // updateRoomUI skips #room-name-display whenever #room-name-input
        // exists — so without this the display kept the pre-edit name until
        // the next unrelated doc change.
        if (yjsSync) {
          nameEl.textContent = (yjsSync.doc.getMap('roomInfo').get('name') as string) || 'Lobby';
        }
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

  // ChiaHub Slice 3b: the "advanced Chia mesh mode" switch. Writes the per-room
  // flag and re-sends the room cap so the node picks it up live (no reconnect).
  const chiaToggle = document.getElementById('chia-mode-toggle') as HTMLInputElement | null;
  if (chiaToggle) {
    chiaToggle.addEventListener('change', () => {
      const roomId = (window as unknown as { __ssfRoomId?: string }).__ssfRoomId;
      const on = chiaToggle.checked;
      const state = document.getElementById('chia-mode-state');
      if (state) state.textContent = on ? 'ON' : 'OFF';
      if (roomId) {
        try { localStorage.setItem(`ssf-chia-mode-${roomId}`, on ? '1' : '0'); } catch { /* privacy mode */ }
      }
      // Apply live — re-send this room's cap to the local node with the new flag.
      void networkProvider.resendRoomCap(on);
      if (feedback) {
        feedback.textContent = on
          ? 'Advanced Chia mesh mode ON for this room (experimental — needs a chia-lane node + funded testnet wallet; otherwise a harmless no-op).'
          : 'Advanced Chia mesh mode OFF for this room.';
        setTimeout(() => { if (feedback) feedback.textContent = ''; }, 5000);
      }
    });
    refreshChiaModeToggle();
  }

  // ?seed= deep-link import (unchanged bootstrap path — only the input it
  // echoes into moved to the phone with #52).
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
      const accessPassInput = document.getElementById('access-pass-input') as HTMLInputElement | null;
      if (accessPassInput) {
        accessPassInput.value = window.location.href;
      }
    }
  }

  // (The Copy Invite handler and its R1 pre-flight warning live in the
  //  ACCESS app now — setupSpacePhoneOverlay + inviteReachabilityWarning.)

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

      // #52: the shareable field lives in the ACCESS app now — write the
      // override-minted pass there so diagnostics keep a copyable artifact.
      const passOutput = document.getElementById('access-pass-output') as HTMLInputElement | null;
      if (passOutput) {
        passOutput.value = minted.link;
      }

      if (feedback) {
        feedback.textContent = 'Override invite written to the phone ACCESS app (diagnostics mode).';
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

  // R1: keep the REACHABILITY row (and the cached fingerprint feeding invite
  // hints) live. Portmapper mappings and the echo advert appear/heal minutes
  // after node startup, and the node classifies per request — poll gently.
  void refreshLocalFingerprint();
  window.setInterval(() => { void refreshLocalFingerprint(); }, 60_000);

  // (The Use Link accept path moved to the ACCESS app with #52 — USE PASS
  //  runs the curtain-covered swap via accessBeamTransport, which already
  //  honors the transit latch the old handler guarded with review fix F5.)
}

/** Keep the ACCESS app's MY PASS field current for the room we just joined
 *  (pre-#52 this fed the network panel's share-link input). Runs per join,
 *  so after a transit/beam the visible pass always belongs to the CURRENT
 *  room without pressing GENERATE. */
async function syncAccessPass(): Promise<void> {
  const passOutput = document.getElementById('access-pass-output') as HTMLInputElement | null;
  if (!passOutput) {
    return;
  }

  const minted = await mintBootstrapLink();
  if (minted.link) {
    passOutput.value = minted.link;
  } else {
    passOutput.value = minted.error ?? 'Local node not reachable — launch the app (or Rust node) first.';
  }
}

/** Paint the ACCESS app's MY PASS room row (name + roomId) from the live
 *  session (#52). Called when the ACCESS view opens (covers offline/pre-join
 *  states), after a successful beam-in, and from the per-join roomInfo /
 *  players observers so a rename or ownership resolve repaints it live. */
// ── Room access mode (public-doors) ──────────────────────────────────────────
// The room's ENTRY policy, synced in roomInfo and surfaced at every door LED
// + the ACCESS app. PUBLIC = anyone enters; PASS = anyone with the link
// (today's default); KEYED = granted keys only (enforced once keyed identity
// ships — see brainstorming/keyed-identity-contacts-plan.md §9). Owner-set.
type AccessMode = 'public' | 'pass' | 'keyed';

const ACCESS_MODE_COPY: Record<AccessMode, string> = {
  public: 'PUBLIC · anyone can enter this room.',
  pass: 'PASS · anyone with the link can enter (default).',
  keyed: 'KEYED · granted keys only (enforced once keyed identity ships).',
};

function getRoomAccessMode(): AccessMode {
  const m = yjsSync?.doc.getMap('roomInfo').get('accessMode');
  return m === 'public' || m === 'keyed' ? m : 'pass';
}

function isLocalOwnerOfCurrentRoom(): boolean {
  const owner = yjsSync?.doc.getMap('roomInfo').get('owner') as string | undefined;
  return !!owner && isLocalPlayerRoomOwner(owner);
}

function setRoomAccessMode(mode: AccessMode): void {
  if (!yjsSync || !isLocalOwnerOfCurrentRoom()) return; // owner-gated
  const rm = yjsSync.doc.getMap('roomInfo');
  yjsSync.doc.transact(() => rm.set('accessMode', mode));
}

/** Reflect the current access mode: tint the door LEDs + paint the ACCESS
 *  app's selector (owner-editable, everyone else read-only). */
function applyAccessModeUI(mode: AccessMode): void {
  world.dockingSystem?.setAccessMode(mode);
  const isOwner = isLocalOwnerOfCurrentRoom();
  const row = document.getElementById('access-mode-row');
  if (row) {
    for (const btn of row.querySelectorAll<HTMLButtonElement>('.access-mode-btn')) {
      const btnMode = btn.dataset.accessMode as AccessMode;
      btn.setAttribute('aria-checked', String(btnMode === mode));
      btn.disabled = !isOwner;
      btn.classList.toggle('is-disabled', !isOwner);
      btn.title = isOwner ? `Set room access to ${btnMode}` : 'Only the room owner can change access mode';
    }
  }
  const note = document.getElementById('access-mode-note');
  if (note) note.textContent = isOwner ? ACCESS_MODE_COPY[mode] : `${ACCESS_MODE_COPY[mode]} (owner-set)`;
}

function refreshAccessRoomRow(): void {
  applyAccessModeUI(getRoomAccessMode());
  const nameEl = document.getElementById('access-room-name');
  const idEl = document.getElementById('access-room-id');
  if (!nameEl || !idEl) return;
  if (!yjsSync) {
    nameEl.textContent = 'OFFLINE';
    idEl.textContent = 'no room joined';
    return;
  }
  nameEl.textContent = (yjsSync.doc.getMap('roomInfo').get('name') as string | undefined) || 'Lobby';
  idEl.textContent = activeBootstrap?.roomId ?? getDefaultRoomId();
}

// ── 👥 Contacts app (keyed identity §8) ──────────────────────────────────────

/** Repaint the phone identity row (name + key fingerprint). Module-level so
 *  actions outside setupSpacePhoneOverlay (identity restore) can refresh it. */
function refreshIdentityKeyRow(): void {
  const nameEl = document.getElementById('phone-player-name');
  if (nameEl) nameEl.textContent = getPlayerName();
  const keyEl = document.getElementById('phone-identity-key');
  if (keyEl) {
    keyEl.textContent = `🔑 ${getIdentityFingerprint()}`;
    keyEl.title = `Cryptographic identity (keyed-identity): ${getIdentityPub()}`;
  }
}

let contactsAppInited = false;

function setContactsFeedback(msg: string): void {
  const el = document.getElementById('contacts-feedback');
  if (el) el.textContent = msg;
}

/** Bind the Contacts app once: share/import cards, recovery, friend/contact
 *  list actions (delegated). Re-render on any contacts change. */
function setupContactsApp(): void {
  if (contactsAppInited) return;
  contactsAppInited = true;

  const discoverableBox = document.getElementById('contacts-discoverable') as HTMLInputElement | null;
  if (discoverableBox) {
    discoverableBox.checked = isDiscoverable();
    discoverableBox.addEventListener('change', () => {
      setDiscoverable(discoverableBox.checked);
      setContactsFeedback(discoverableBox.checked
        ? 'Discoverable — re-share your card so friends can introduce you.'
        : 'No longer discoverable. New cards you share opt out.');
    });
  }

  document.getElementById('contacts-share-btn')?.addEventListener('click', () => {
    const card = encodeMyCard();
    const out = document.getElementById('contacts-my-card') as HTMLInputElement | null;
    if (out) { out.value = card; out.select(); }
    navigator.clipboard?.writeText(card).then(
      () => setContactsFeedback('Your card is copied — share it however you like.'),
      () => setContactsFeedback('Your card is shown above — copy it manually.'),
    );
  });

  const addBtn = document.getElementById('contacts-add-btn');
  const addInput = document.getElementById('contacts-add-input') as HTMLInputElement | null;
  addBtn?.addEventListener('click', () => {
    const raw = addInput?.value.trim();
    if (!raw) { setContactsFeedback('Paste a contact card first.'); return; }
    const result = addContactFromCard(raw);
    if (!result.ok) { setContactsFeedback(result.error); return; }
    if (addInput) addInput.value = '';
    setContactsFeedback(result.isSelf
      ? "That's your own card."
      : `Added ${result.name} · 🔑 ${contactFingerprint(result.pub)}. Verify the fingerprint out-of-band.`);
  });

  // Recovery: reveal export / restore (destructive — swaps your identity).
  document.getElementById('contacts-export-btn')?.addEventListener('click', () => {
    const out = document.getElementById('contacts-recovery-out') as HTMLInputElement | null;
    if (out) { out.value = (window as any).__ssfIdentity.exportRecoveryKey(); out.select(); }
    setContactsFeedback('Recovery key revealed — store it somewhere only you control.');
  });
  document.getElementById('contacts-import-key-btn')?.addEventListener('click', () => {
    const inp = document.getElementById('contacts-recovery-in') as HTMLInputElement | null;
    const raw = inp?.value.trim();
    if (!raw) { setContactsFeedback('Paste a recovery key to restore.'); return; }
    const newPub = (window as any).__ssfIdentity.importRecoveryKey(raw);
    if (!newPub) { setContactsFeedback('That is not a valid recovery key.'); return; }
    if (inp) inp.value = '';
    // The old identity's DM rooms are derived from the OLD pubkey pair and would
    // sign/verify-mismatch under the new key — tear them down (review LOW).
    closeDmOverlay();
    void closeAllDms();
    // Re-assert the restored identity into the current room's player entry.
    updateLocalPlayerEntry();
    refreshIdentityKeyRow();
    refreshContactsApp();
    setContactsFeedback('Identity restored. Your key fingerprint updated.');
  });

  // Delegated list actions (friend toggle, DM, remove) for both lists.
  const onListClick = (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-contact-act]');
    if (!btn) return;
    const pub = btn.dataset.contactPub;
    if (!pub) return;
    switch (btn.dataset.contactAct) {
      case 'friend': setFriend(pub, true); setContactsFeedback('Added to friends.'); break;
      case 'unfriend': setFriend(pub, false); setContactsFeedback('Removed from friends.'); break;
      case 'remove': removeContact(pub); setContactsFeedback('Contact removed.'); break;
      case 'dm': openDirectMessage(pub); break;
    }
  };
  document.getElementById('contacts-friends-list')?.addEventListener('click', onListClick);
  document.getElementById('contacts-all-list')?.addEventListener('click', onListClick);

  // Keep the app live while it (or anything) mutates the contacts store or the
  // mesh peer store (room harvest densifies the mesh while you're in a room).
  subscribeContacts(() => { if (isContactsAppOpen()) refreshContactsApp(); });
  subscribePeers(() => { if (isContactsAppOpen()) refreshContactsApp(); });
}

function isContactsAppOpen(): boolean {
  const el = document.getElementById('phone-app-contacts');
  return !!el && el.classList.contains('active');
}

function contactRowHtml(name: string, pub: string, opts: { friend: boolean }): string {
  const fp = contactFingerprint(pub);
  const safeName = escapeHtml(name);
  const safePub = escapeHtml(pub); // defense-in-depth: pub is canonical b64url today, but never trust it into HTML
  const friendBtn = opts.friend
    ? `<button type="button" data-contact-act="unfriend" data-contact-pub="${safePub}" title="Remove from friends">★</button>`
    : `<button type="button" data-contact-act="friend" data-contact-pub="${safePub}" title="Add to friends">☆</button>`;
  const dmBtn = opts.friend
    ? `<button type="button" data-contact-act="dm" data-contact-pub="${safePub}" title="Direct message">💬</button>`
    : '';
  return `<div class="contact-row" role="listitem">
    <span class="contact-name" title="${safePub}">${safeName}</span>
    <span class="contact-fp" title="Identity fingerprint">🔑 ${fp}</span>
    <span class="contact-actions">${dmBtn}${friendBtn}<button type="button" data-contact-act="remove" data-contact-pub="${safePub}" title="Remove contact">✕</button></span>
  </div>`;
}

function refreshContactsApp(): void {
  const nameEl = document.getElementById('contacts-my-name');
  const fpEl = document.getElementById('contacts-my-fp');
  if (nameEl) nameEl.textContent = getPlayerName();
  if (fpEl) fpEl.textContent = `🔑 ${getIdentityFingerprint()}`;

  const friends = listFriends();
  const all = listContacts();
  const friendsList = document.getElementById('contacts-friends-list');
  const allList = document.getElementById('contacts-all-list');
  if (friendsList) {
    friendsList.innerHTML = friends.length
      ? friends.map((c) => contactRowHtml(c.name, c.pub, { friend: true })).join('')
      : '<div class="phone-access-note">No friends yet — add a contact, then tap ☆ to make them a friend.</div>';
  }
  if (allList) {
    allList.innerHTML = all.length
      ? all.map((c) => contactRowHtml(c.name, c.pub, { friend: c.friend })).join('')
      : '<div class="phone-access-note">No contacts yet — share your card and paste one back.</div>';
  }
  const meshNote = document.getElementById('contacts-mesh-note');
  if (meshNote) {
    const n = peerCount();
    const routable = listPeers().filter((p) => p.hints != null).length;
    meshNote.textContent = n
      ? `${n} peer${n === 1 ? '' : 's'} known · ${routable} with a live route. Every verified identity you meet strengthens the network.`
      : 'Every verified identity you meet strengthens the peer network.';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  ));
}

/** 🕸️ Mesh harvest (§7 M1): fold every contact/friend into the peer store.
 *  Friends outrank plain contacts; hints (reachability) carry through. */
function harvestContactsIntoMesh(): void {
  for (const c of listContacts()) {
    recordPeer({
      pub: c.pub,
      name: c.name,
      hints: (c.hints as RoomMemberHint | undefined) ?? null,
      trust: c.friend ? 'friend' : 'contact',
    });
  }
}

/** 🕸️ Mesh harvest (§7 M1): fold room co-members into the peer store — but
 *  ONLY those whose name↔key self-cert verifies (an unverified keyB64 is an
 *  untrusted claim anyone could write into the map). A room encounter carries
 *  identity, not a route, so it seeds the graph at 'room' trust until a card or
 *  introduction supplies reachability. */
const verifiedCertCache = new Set<string>(); // memo of (keyB64|name|keySig) already verified
function harvestRoomPlayersIntoMesh(players: { forEach: (cb: (v: unknown) => void) => void }): void {
  players.forEach((value) => {
    const e = value as Partial<PlayerEntry>;
    if (!e.keyB64 || !e.keySig || !e.name) return;
    // Memoize the Ed25519 verify so a busy players map (a name/outfit edit fires
    // the observer) doesn't re-verify every entry each change (review perf).
    const cacheKey = `${e.keyB64}|${e.name}|${e.keySig}`;
    if (verifiedCertCache.has(cacheKey)) return; // verified + recorded already
    if (!verifyNameCert(e.name, e.keyB64, e.keySig)) return;
    verifiedCertCache.add(cacheKey);
    recordPeer({ pub: e.keyB64, name: e.name, hints: null, trust: 'room' });
  });
}

// ── 💬 Direct-message overlay (keyed identity §8) ────────────────────────────

let dmOverlayInited = false;
let dmActivePeer: string | null = null;
let dmActiveSession: DmSession | null = null;
let dmObserver: (() => void) | null = null;

function setupDmOverlay(): void {
  if (dmOverlayInited) return;
  dmOverlayInited = true;
  document.getElementById('dm-close')?.addEventListener('click', closeDmOverlay);
  const form = document.getElementById('dm-form') as HTMLFormElement | null;
  const input = document.getElementById('dm-input') as HTMLInputElement | null;
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input?.value ?? '';
    if (!text.trim() || !dmActiveSession) return;
    sendMessage(dmActiveSession, text);
    if (input) input.value = '';
    renderDmMessages(); // local echo is immediate; the observer covers remote
  });
  // Esc closes the DM (capture so it beats the phone's Esc-to-home handler).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('dm-overlay')?.hasAttribute('hidden')) {
      e.stopPropagation();
      closeDmOverlay();
    }
  }, true);
}

function setDmStatus(text: string): void {
  const el = document.getElementById('dm-status');
  if (el) el.textContent = text;
}

function renderDmMessages(): void {
  const list = document.getElementById('dm-messages');
  if (!list || !dmActiveSession) return;
  const me = getIdentityPub();
  const msgs: DirectMessage[] = readMessages(dmActiveSession);
  if (!msgs.length) {
    list.innerHTML = '<div id="dm-empty">No messages yet — say hello. Messages are signed (authenticated), not encrypted.</div>';
    return;
  }
  list.innerHTML = msgs.map((m) => {
    const mine = m.author === me;
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="dm-msg ${mine ? 'dm-mine' : 'dm-theirs'}">${escapeHtml(m.text)}<span class="dm-msg-meta">${escapeHtml(mine ? 'you' : m.authorName)} · ${time}</span></div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

/** Open a friend's private conversation — connects the DM transport (dialing
 *  them via their card hints) and streams the signed history. */
function openDirectMessage(pub: string): void {
  setupDmOverlay();
  const contact = getContact(pub);
  const overlay = document.getElementById('dm-overlay');
  const nameEl = document.getElementById('dm-peer-name');
  const fpEl = document.getElementById('dm-peer-fp');
  if (nameEl) nameEl.textContent = contact?.name ?? 'Contact';
  if (fpEl) fpEl.textContent = `🔑 ${contactFingerprint(pub)}`;
  dmActivePeer = pub;
  overlay?.removeAttribute('hidden');
  document.getElementById('dm-messages')!.innerHTML = '<div id="dm-empty">Connecting…</div>';
  setDmStatus('connecting');
  (document.getElementById('dm-input') as HTMLInputElement | null)?.focus();

  // Prefer the contact card's own route; fall back to the mesh peer store
  // (§7 M1 consume) — a route another encounter/introduction supplied.
  const hints = (contact?.hints as RoomMemberHint | undefined) ?? hintsFor(pub) ?? null;
  openDm(pub, hints).then(
    (session) => {
      if (dmActivePeer !== pub) return; // user already navigated away
      dmActiveSession = session;
      (window as any).__ssfDM.active = session; // debug hook (matches __players etc.)
      setDmStatus('connected');
      gossipIntroductions(session); // §7 M2: densify the mesh over this friend link
      renderDmMessages();
      // Live updates: re-render on any change to the conversation array.
      const obs = () => { if (dmActivePeer === pub) renderDmMessages(); };
      session.messages.observe(obs);
      dmObserver = () => session.messages.unobserve(obs);
    },
    (err) => {
      if (dmActivePeer !== pub) return;
      setDmStatus('offline');
      const list = document.getElementById('dm-messages');
      if (list) list.innerHTML = `<div id="dm-empty">Could not reach ${escapeHtml(contact?.name ?? 'contact')} — they may be offline. ${escapeHtml(String(err?.message ?? ''))}</div>`;
    },
  );
}

function closeDmOverlay(): void {
  document.getElementById('dm-overlay')?.setAttribute('hidden', '');
  if (dmObserver) { dmObserver(); dmObserver = null; }
  const peer = dmActivePeer;
  dmActivePeer = null;
  dmActiveSession = null;
  // Keep the transport warm briefly? No — tear it down so we don't hold a
  // connection per contact. A re-open reconnects (fast; node stays warm).
  if (peer) void closeDm(peer);
}

/**
 * 🤝 §7 M2: gossip signed friend-of-friend introductions over an open DM. We
 * publish introductions for OUR discoverable contacts (the friend learns routes
 * to them), and ingest the ones they publish (trust + consent gated) into the
 * mesh peer store — so the network densifies from every friend connection.
 */
const gossipedSessions = new WeakSet<DmSession>();

function gossipIntroductions(session: DmSession): void {
  if (gossipedSessions.has(session)) return; // once per session (re-open/double-tap guard)
  gossipedSessions.add(session);
  const introsArr = session.sync.doc.getArray<Introduction>('intros');

  // Publish OUR discoverable contacts' introductions once — each carries the
  // subject's OWN signed card (reconstructCard), so consent is subject-proven.
  const mine = makeIntroductions(
    listContacts().map(reconstructCard).filter((c): c is ContactCard => !!c),
  );
  if (mine.length) session.sync.doc.transact(() => { introsArr.push(mine); });

  // Delta-ingest: process only entries past the cursor on each fire (no O(n^2)
  // full re-verify), deduped by (subjectPub, introducerPub).
  const seen = new Set<string>();
  let cursor = 0;
  const ingestNew = () => {
    const all = introsArr.toArray();
    for (; cursor < all.length; cursor++) {
      const intro = all[cursor];
      const key = intro && intro.card ? `${intro.card.pub}|${intro.introducerPub}` : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      ingestIntroduction(intro, {
        // Trust the introducer iff it's the friend we're DMing, or already a
        // vetted (friend/contact) peer in our store — never an unvetted key.
        isTrustedIntroducer: (introPub) => {
          if (introPub === session.peerPub) return true;
          const p = getPeer(introPub);
          return !!p && (p.trust === 'friend' || p.trust === 'contact');
        },
        record: ({ pub, name, hints, introducer }) =>
          recordPeer({ pub, name, hints, trust: 'introduced', introducer }),
      });
    }
  };
  ingestNew();
  introsArr.observe(ingestNew);
}

// ── MY ROOMS list (issue #60 staged room-list) ───────────────────────────────

/** The room a just-added pass should auto-enter once it warms to READY (the
 *  streamlined "join now" flow). Cleared on enter, on OFFLINE timeout, or when
 *  the user makes a manual choice (ENTER/JUMP another room). */
let autoEnterRoomId: string | null = null;

/** Enter a room from its pass — the ACCESS beam, now fast because a READY
 *  room is already warm on the node (no minutes-long re-dial). Also the DEV
 *  "jump now" path (immediate, before READY). */
async function enterRoomFromPass(seed: string): Promise<void> {
  const setAccessFeedback = (msg: string) => {
    const el = document.getElementById('access-feedback');
    if (el) el.textContent = msg;
  };
  if (world.getPlayer().isInAdapterTransit()) {
    setAccessFeedback('Docking transit in progress — enter once you are through.');
    return;
  }
  setAccessFeedback('Entering room…');
  const result = await accessBeamTransport(seed);
  if (result === 'busy') {
    setAccessFeedback('A transit is already in progress — try again in a moment.');
    return;
  }
  if (result instanceof Error) {
    setAccessFeedback(result instanceof StrandedOfflineError
      ? `Entry failed — ${result.message}. No room to return to — node OFFLINE.`
      : `Entry failed — ${result.message}. Returned to your room.`);
    return;
  }
  setAccessFeedback('Welcome aboard.');
  refreshAccessRoomRow();
}

function passStatusLabel(state: PassState): string {
  switch (state) {
    case 'connecting': return '<span class="access-room-spinner"></span>CONNECTING…';
    case 'loading': return '<span class="access-room-spinner"></span>LOADING…';
    case 'ready': return 'READY';
    case 'current': return 'YOU ARE HERE';
    // "UNREACHABLE", not "NODE OFFLINE": when a warm times out it's almost always
    // the HOST that couldn't be reached (offline / behind NAT), NOT the local
    // node — the old label made people think their own node was broken.
    case 'offline': return 'UNREACHABLE';
  }
}

// ── Room categorisation: My Rooms / Friends' Rooms / Visited / Unreached ──────
type RoomCategory = 'mine' | 'friend' | 'visited' | 'unreached';

/** Owner of a room by roomId. The room you're CURRENTLY in reads from the live
 *  session doc; any other (saved-pass) room reads from its background prefetch
 *  doc (empty until it has synced). */
function roomOwnerInfo(roomId: string): { ownerId?: string; ownerPub?: string } {
  const currentRoomId = (window as unknown as { __ssfRoomId?: string }).__ssfRoomId;
  if (roomId === currentRoomId && yjsSync) {
    const doc = yjsSync.doc;
    const ownerId = doc.getMap('roomInfo').get('owner');
    if (typeof ownerId !== 'string' || !ownerId) return {};
    const entry = doc.getMap('players').get(ownerId) as { keyB64?: string } | undefined;
    return { ownerId, ownerPub: typeof entry?.keyB64 === 'string' ? entry.keyB64 : undefined };
  }
  return passRoomInfo(roomId);
}

/** Which list a room belongs in. Owner unknown (not synced) ⇒ 'unreached' so we
 *  never mis-file a room we haven't actually reached. `friendPubs` is passed in
 *  (computed once per render) rather than re-derived per room. */
function categorizeRoom(roomId: string, friendPubs: Set<string>): RoomCategory {
  const { ownerId, ownerPub } = roomOwnerInfo(roomId);
  if (!ownerId) return 'unreached';
  // 'Local-Clone' is the legacy self-owned marker (pre-keyed-identity rooms).
  if (ownerId === getPlayerId() || ownerId === 'Local-Clone' || (ownerPub && ownerPub === getIdentityPub())) {
    return 'mine';
  }
  if (ownerPub && friendPubs.has(ownerPub)) return 'friend';
  return 'visited';
}

interface RoomEntry {
  roomId: string;
  name: string;
  seed: string;
  state: PassState;
  /** Saved passes can be removed; the synthesised current-room row cannot. */
  removable: boolean;
}

function currentRoomDisplayName(): string {
  const name = yjsSync?.doc.getMap('roomInfo').get('name');
  return (typeof name === 'string' && name) ? name : 'Your room';
}

/** A room's LIVE display name: for the room you're currently IN, read the active
 *  session doc so a local rename shows instantly; otherwise use the pass's stored
 *  name (kept current by roomPasses' roomInfo observer) or the roomId. */
function liveRoomName(roomId: string, fallback: string): string {
  const currentRoomId = (window as unknown as { __ssfRoomId?: string }).__ssfRoomId;
  if (roomId === currentRoomId && yjsSync) {
    const n = yjsSync.doc.getMap('roomInfo').get('name');
    if (typeof n === 'string' && n) return n;
  }
  return fallback;
}

function buildRoomRow(e: RoomEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = `access-room-item is-${e.state}`;
  row.setAttribute('role', 'listitem');

  const info = document.createElement('div');
  info.className = 'access-room-info';
  const title = document.createElement('div');
  title.className = 'access-room-title';
  title.textContent = e.name || e.roomId;
  title.title = e.roomId;
  const status = document.createElement('div');
  status.className = 'access-room-status';
  status.innerHTML = passStatusLabel(e.state);
  info.append(title, status);

  const actions = document.createElement('div');
  actions.className = 'access-room-actions';
  if (e.state !== 'current') {
    const enter = document.createElement('button');
    enter.className = 'access-room-btn' + (e.state === 'ready' ? '' : ' is-disabled');
    enter.textContent = 'ENTER';
    enter.setAttribute('aria-label', `Enter ${e.name}`);
    if (e.state === 'ready') {
      enter.addEventListener('click', () => { autoEnterRoomId = null; void enterRoomFromPass(e.seed); });
    }
    actions.append(enter);
    // DEV escape hatch: jump immediately, before the room finishes loading.
    const jump = document.createElement('button');
    jump.className = 'access-room-btn access-room-dev';
    jump.textContent = 'JUMP';
    jump.title = 'DEV: jump immediately (before READY)';
    jump.setAttribute('aria-label', `DEV jump to ${e.name} now`);
    jump.addEventListener('click', () => { autoEnterRoomId = null; void enterRoomFromPass(e.seed); });
    actions.append(jump);
  }

  row.append(info, actions);
  if (e.removable) {
    const remove = document.createElement('button');
    remove.className = 'access-room-remove';
    remove.textContent = '✕';
    remove.title = 'Remove this pass';
    remove.setAttribute('aria-label', `Remove pass for ${e.name}`);
    remove.addEventListener('click', () => removePass(e.roomId));
    row.append(remove);
  }
  return row;
}

function renderPassesList(): void {
  const container = document.getElementById('access-rooms-list');
  if (!container) return;

  const passes = listPasses();
  const entries: RoomEntry[] = passes.map((p) => ({
    roomId: p.roomId,
    name: liveRoomName(p.roomId, p.name || p.roomId),
    seed: p.seed,
    state: passState(p.roomId),
    removable: true,
  }));
  // Always surface the room you're currently in, in its owner's section (your
  // home room → My Rooms; a friend's room you're visiting → Friends'), unless
  // it's already a saved pass (passState marks that one 'current' already).
  const currentRoomId = (window as unknown as { __ssfRoomId?: string }).__ssfRoomId;
  if (currentRoomId && !passes.some((p) => p.roomId === currentRoomId)) {
    entries.push({
      roomId: currentRoomId,
      name: currentRoomDisplayName(),
      seed: '',
      state: 'current',
      removable: false,
    });
  }

  if (entries.length === 0) {
    container.innerHTML = '<div id="access-rooms-empty">No rooms yet — add a pass above.</div>';
    return;
  }

  const friendPubs = new Set(listFriends().map((f) => f.pub));
  const buckets: Record<RoomCategory, RoomEntry[]> = { mine: [], friend: [], visited: [], unreached: [] };
  for (const e of entries) buckets[categorizeRoom(e.roomId, friendPubs)].push(e);

  const sections: Array<[RoomCategory, string]> = [
    ['mine', 'MY ROOMS'],
    ['friend', "FRIENDS' ROOMS"],
    ['visited', 'VISITED'],
    ['unreached', 'UNREACHED'],
  ];

  container.textContent = '';
  for (const [cat, label] of sections) {
    const list = buckets[cat];
    if (list.length === 0) continue;
    const head = document.createElement('div');
    head.className = `access-rooms-subhead is-${cat}`;
    head.textContent = `${label} · ${list.length}`;
    container.append(head);
    for (const e of list) container.append(buildRoomRow(e));
  }
}

function encodeBootstrapSeed(boot: RoomBootstrap): string {
  return btoa(JSON.stringify(boot));
}

function decodeBootstrapSeed(seed: string): RoomBootstrap | null {
  try {
    const parsed = JSON.parse(atob(seed));

    // A pass MUST name its own room. The old fallback to getDefaultRoomId() —
    // OUR OWN room — meant a pass that lost its roomId was silently "added" as
    // our current room (ADD PASS appeared to refresh your own room instead of
    // adding the pasted one, and startPrefetch no-oped because it was active).
    // Reject instead, so a malformed pass surfaces as "Invalid pass".
    const roomId = typeof parsed.roomId === 'string' && parsed.roomId.length > 0
      ? parsed.roomId
      : null;
    if (!roomId) return null;

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
    // S2: label offline-sim bubbles with the real display name. Built via
    // textContent — both the name and the message are user-typed strings.
    const senderSpan = document.createElement('span');
    senderSpan.className = 'chat-sender-name';
    senderSpan.textContent = getPlayerName();
    ourBubble.appendChild(senderSpan);
    ourBubble.appendChild(document.createTextNode(val));
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

// M-dep of #33: the fullscreen solar-map overlay is retired — the 'm' hotkey,
// the #solarmap-toggle-btn and the +/- HUD zoom buttons are gone. The solar
// map now lives INSIDE the world: click the holographic map table (M4) and
// the same SolarSystemMap mounts into the device-focus panel (devices.ts
// createMapTableUI). Keyboard +/- zoom survives in zoom.ts, clamped at
// level 2 unless ?devzoom=1.
function setupZoomView() {
  // Mount Multiscale Keyboard Zoom manager
  multiScaleZoom = new MultiScaleZoomView();
  multiScaleZoom.mount(document.body);
  (window as any).multiScaleZoom = multiScaleZoom;
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

  // ── Room-edit owner gate (E2 of #25, plan §1), on S2's identity:
  // isLocalPlayerRoomOwner accepts the local playerId AND the legacy
  // 'Local-Clone' owner (pre-S2 rooms stay editable). The reason string
  // resolves the owner's display name through the players map.
  setRoomEditPermission(() => {
    if (!yjsSync) return { ok: true }; // offline: your room
    const owner = (yjsSync.doc.getMap('roomInfo').get('owner') as string | undefined) ?? 'Local-Clone';
    return isLocalPlayerRoomOwner(owner)
      ? { ok: true }
      : { ok: false, reason: `Only the owner (${resolveOwnerLabel(owner)}) can edit this room.` };
  });

  // ── Outfit v1 (TR3 rig half of #35): re-apply the locally saved outfit and
  // expose a debug console handle. LOCAL rig only — S2 now carries outfitId in
  // the room doc's players map (data foundation), but remote avatars keep
  // #27's per-peer hue tint until S3 lands the lane-id → player-id mapping
  // (tick-lane peers key by per-connection lane id; pairing rigs to players
  // map entries without that mapping would be a guess for 2+ remotes).
  const applyOutfitById = (id: string): boolean => {
    const outfit = getOutfitById(id);
    if (!outfit) { console.warn(`[outfit] unknown outfit id: ${id}`); return false; }
    // Player keeps its rig private; reach through for this cosmetic path
    // instead of widening the frozen player/character public API.
    (world.getPlayer() as any).character.setOutfit(outfit);
    saveOutfitId(id);
    updateLocalPlayerEntry(); // S2: mirror outfitId into the room doc's players map
    return true;
  };
  (window as any).__setOutfit = applyOutfitById; // debug handle (permanent)
  const savedOutfitId = loadSavedOutfitId();
  if (savedOutfitId && savedOutfitId !== 'default' && !applyOutfitById(savedOutfitId)) {
    saveOutfitId('default'); // self-heal a stale/unknown saved id — warn once, not every boot
  }

  // ── Dev-only preview flag (PR-A of #30): `?vestibule=<north|south|east|west>`
  // renders the docking-adapter vestibule outside that door for visual
  // iteration. No gameplay/network/docking wiring — cosmetic preview only.
  const vestibuleDoor = new URLSearchParams(location.search).get('vestibule');
  if (vestibuleDoor === 'north' || vestibuleDoor === 'south' || vestibuleDoor === 'east' || vestibuleDoor === 'west') {
    try {
      const adapter = await import('./adapter');
      const vestibule = adapter.buildVestibule(vestibuleDoor);
      scene.add(vestibule);
      (window as any).__vestibule = vestibule; // console handle for visual iteration
      (window as any).__setVestibuleLightState = (s: 'idle' | 'cycling' | 'fault') =>
        adapter.setVestibuleLightState(vestibule, s);
      // Honor the zoom-hide convention (world.ts hides interior detail at zoom >= 3)
      setInterval(() => {
        const zv = (window as any).multiScaleZoom;
        vestibule.visible = !zv || typeof zv.getLevel !== 'function' || zv.getLevel() < 3;
      }, 250);
    } catch (e) {
      // A failed preview chunk load must never take the whole app down.
      console.warn('vestibule preview failed to load:', e);
    }
  }

  // (The PR-P `?deviceprops=1` preview flag is fully retired: the wall
  // computer graduated with D0+M1 and the storage trunk with TR2 — both are
  // real furniture-registry items now, so the flag would spawn nothing.
  // deviceProps.ts was deleted with it.)

  // Initialize input manager
  inputManager = new inputModule.InputManager();
  setupNetworkDetailsPanel();
  setupZoomView();

  // Camera rig: 45° view-rotation arrows (bottom-left HUD, next to DEV).
  // Injected probes keep cameraRig.ts import-cycle-free: it must not import
  // zoom.ts (which imports it for rotated level snaps) nor deviceFocus.ts.
  initCameraRig({
    getZoomLevel: () => (multiScaleZoom ? multiScaleZoom.getLevel() : 2),
    isCameraBusy: () => isDeviceFocusActive(),
  });

  // DEV1: temporary Development menu (owner request, demo phase — will be
  // phased out). Removal = delete src/devMenu.ts, the #dev-menu-btn line in
  // index.html, and these three lines.
  const { initDevMenu } = await import('./devMenu');
  initDevMenu(() => world);
  
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
    // startMorph built the docking system synchronously — wire the adapter
    // transit driver + PROVISION NEW MODULE minting onto it (T1 of #30).
    wireAdapterTransit();
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

  // ── First-person pointer-lock click model (#49): the click paired with the
  //    mousedown that freed the cursor from pointer lock is swallowed — its
  //    coordinates are frozen at the lock point and must not raycast.
  //    Subsequent unlocked clicks fall through and interact normally.
  if (multiScaleZoom && multiScaleZoom.getLevel() === 1
      && multiScaleZoom.consumeFirstPersonUnlockClick()) {
    return;
  }

  // ── While the device-focus camera is live, any click reaching the canvas
  //    releases the focus (#33 D0.3 — device-UI panels stop propagation, so
  //    UI clicks never land here). Raycasting is skipped entirely: the view
  //    is the focus perspective camera, not the isometric one.
  if (isDeviceFocusActive()) {
    deviceFocus.release();
    return;
  }

  // ── Edit mode owns clicks (E2 of #25, routed BEFORE the keypad → door →
  //    device passes per the #33 M2 amendment): a click on a movable item
  //    selects it, a click anywhere else deselects — and navigation is
  //    suppressed entirely (WASD stays live for walking while editing).
  if (roomEdit.isEditModeActive()) {
    roomEdit.handleClick(event);
    return;
  }

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

  // ── Door-body clicks → walk-through sequence (keypads keep priority) ──────
  {
    const doorBodies: THREE.Object3D[] = [];
    scene.traverse((child) => {
      if (child.userData && child.userData.isDoorBody) {
        doorBodies.push(child);
      }
    });

    const doorHits = raycaster.intersectObjects(doorBodies, false);
    if (doorHits.length > 0) {
      const doorId = doorHits[0].object.userData.doorId as string;
      if (doorId) {
        world.requestDoorWalkthrough(doorId);
        return; // Halt floor-click routing
      }
    }
  }

  // ── Device clicks → walk-to + first-person focus (#33 D0; keypads and door
  //    bodies keep priority). v1: routed at zoom level 2 only (plan §D0.2 —
  //    the level-1 perspective raycast is deferred). #49 keeps this gate:
  //    from first person, seats/floor-walk (via the click plane below) and
  //    keypad/door clicks work, but a device click would swap in the
  //    device-focus camera mid-first-person — that hand-off is deferred with
  //    the rest of D0.2. A first-person device click falls through to the
  //    floor plane and walks the player next to the device instead.
  if (!multiScaleZoom || multiScaleZoom.getLevel() === 2) {
    const deviceMeshes: THREE.Object3D[] = [];
    scene.traverse((child) => {
      if (child.userData && child.userData.isDevice) {
        deviceMeshes.push(child);
      }
    });

    const deviceHits = raycaster.intersectObjects(deviceMeshes, false);
    if (deviceHits.length > 0) {
      const deviceId = deviceHits[0].object.userData.deviceId as string;
      if (deviceId) {
        world.requestDeviceFocus(deviceId);
        return; // Halt floor-click routing
      }
    }
  }

  const hits = raycaster.intersectObject(clickPlane, false);

  for (const hit of hits) {
    if (hit.object.userData.isTile) {
      world.navigateTo(hit.point.x, hit.point.z);
      return;
    }
  }

  // ── #49: a first-person click on INACTIVE space (no keypad / door / device
  //    / floor hit) re-engages pointer lock and resumes look-around. Guarded
  //    to clicks on the 3D canvas itself so DOM/HUD clicks (dev menu, rotate
  //    arrows, panels — which also stopPropagation) can never steal the
  //    cursor. This click is also the user activation the lock request needs.
  if (
    multiScaleZoom && multiScaleZoom.getLevel() === 1 &&
    event.target === window.gameRenderer?.renderer?.domElement
  ) {
    multiScaleZoom.requestFirstPersonPointerLock();
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
  // Clamped: a backgrounded tab pauses rAF, so the first resumed frame sees
  // SECONDS of elapsed time — unclamped, that teleports the player a full
  // bound-width, snaps interpolations, and (before the voxelCharacter clamp)
  // exploded the rig's lerp extrapolation. 100 ms ≈ a 10 fps floor.
  const deltaTime = Math.min((currentTime - lastTime) / 1000, 0.1);
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

  // (M4/M-dep: the solar map's tick moved into the map-table DeviceUI —
  // devices.ts createMapTableUI drives it only while the table is open.)

  if (multiScaleZoom) {
    multiScaleZoom.tick();
  }

  // Camera rig: ease the 45°-detent view rotation and steer the ortho room
  // camera while it owns the view (levels 2–4, no device focus). Runs after
  // the zoom tick so a level snap and the rig agree within the same frame.
  updateCameraRig(deltaTime);

  if (hasEntered && !controlsHintShown && world.isPlayerActive()) {
    const controls = document.getElementById('controls');
    if (controls) {
      controls.style.animation = 'pulse 1s ease-in-out 3';
    }
    controlsHintShown = true;
  }

  // ── Remote-player reaper: despawn replicas that stopped ticking (issue #22)
  if (world && currentTime - lastReaperSweep >= REMOTE_REAPER_SWEEP_MS) {
    lastReaperSweep = currentTime;
    for (const [peerId, lastSeen] of remoteLastSeen) {
      if (currentTime - lastSeen >= REMOTE_PEER_TIMEOUT_MS) {
        remoteLastSeen.delete(peerId);
        world.removeRemotePlayer(peerId);
      }
    }
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
      // #63: broadcast the seated pose over the existing tick lane — bit1 = seated,
      // and the otherwise-unused yaw field carries the seat facing so peers render
      // 'sit_chair' at the right orientation instead of an idle stand at the chair.
      const seated = world.getPlayer().isSeated();
      const tickData = {
        flags: ((dir.x !== 0 || dir.z !== 0) ? 1 : 0) | (seated ? 2 : 0),
        x: localPos.x,
        z: localPos.z,
        yaw: seated ? world.getPlayer().getSeatedFacing() : 0,
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
  
  // Render — camera stays locked except for the rig's 45° view detents
  renderer.render(scene, camera);
}

/**
 * Export debug HUD updater for other modules
 */
export { updateDebugHUD };

// Start the game
init().catch(console.error);
