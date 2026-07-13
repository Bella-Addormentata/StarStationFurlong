/**
 * 📊 Door and Docking Ports System - Phase 2 Verification Feature
 *
 * Implements interactive docking ports (4 doors: North, South, East, West)
 * placed at the center of each room boundary wall. Includes:
 *   - Interactive control panels for room owners to manage pin codes, lock states, and target room connections.
 *   - Blinking notification light on the remote side's control panel.
 *   - Peer acceptance or rejection pairing flows (over WT / Yjs).
 *   - Lightly rendered "gray box" projections of connected adjacent chambers.
 */

import * as THREE from 'three';
import { findDoor } from './doors';
import type { DoorId } from './doors';

/** Advance a scalar toward a target by at most maxStep, landing exactly. */
function moveToward(current: number, target: number, maxStep: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

export interface DockingState {
  doorId: 'north' | 'south' | 'east' | 'west';
  locked: boolean;
  pinCode: string;
  connectedRoomAddress: string; // Target room URL seed
  pairingPending: boolean;
  pairedSuccessfully: boolean;
}

export class DoorDockingPortSystem {
  private roomsGroup: THREE.Group;
  private doorState: Map<'north' | 'south' | 'east' | 'west', DockingState> = new Map();
  private doorObjects: Map<string, THREE.Group> = new Map();
  private adjacentRooms: Map<string, THREE.Mesh> = new Map();

  // ── Update-loop-driven leaf slides ─────────────────────────────────────────
  /** In-flight slide per door; a new open/close overwrites the entry. */
  private slideAnims = new Map<DoorId, { openTarget: number; onComplete?: () => void }>();
  /** Leaf slide speed (metres/second). */
  private readonly SLIDE_SPEED = 2.2;
  
  // Handlers
  private onConnectionRequestCallback: ((doorId: string, address: string) => void) | null = null;
  private onPairingStatusChangedCallback: ((doorId: string, status: string) => void) | null = null;

  constructor(roomsGroup: THREE.Group) {
    this.roomsGroup = roomsGroup;
    this.initializeDoorStates();
  }

  private initializeDoorStates() {
    const directions: ('north' | 'south' | 'east' | 'west')[] = ['north', 'south', 'east', 'west'];
    for (const dir of directions) {
      this.doorState.set(dir, {
        doorId: dir,
        locked: false,
        pinCode: '',
        connectedRoomAddress: '',
        pairingPending: false,
        pairedSuccessfully: false,
      });
    }
  }

  /**
   * Build 3D geometries and click target boxes for our 4 Doors.
   * conformed precisely to the grid: small doors take 1 grid cell width (1.0m on wall)
   * large doors take 2 grid cells width (2.0m on wall)
   */
  public buildPorts() {
    console.log('🚪 Constructing 4-Directional Docking Ports & Control Panels');
    
    // Configurations: [doorId, pos, rot]
    const doorsConfig: Array<{ id: 'north' | 'south' | 'east' | 'west'; pos: THREE.Vector3; rotY: number; isLarge: boolean }> = [
      { id: 'north', pos: new THREE.Vector3(0, 2, -6), rotY: 0, isLarge: false }, // Small door (1.0m width)
      { id: 'south', pos: new THREE.Vector3(0, 2, 6), rotY: Math.PI, isLarge: false }, // Small door (1.0m width)
      { id: 'west', pos: new THREE.Vector3(-6, 2, 0), rotY: Math.PI / 2, isLarge: true }, // Large door (2.0m width)
      { id: 'east', pos: new THREE.Vector3(6, 2, 0), rotY: -Math.PI / 2, isLarge: true }, // Large door (2.0m width)
    ];

    for (const cfg of doorsConfig) {
      const doorGroup = new THREE.Group();
      doorGroup.position.copy(cfg.pos);
      doorGroup.rotation.y = cfg.rotY;

      // Walkability comes from the door registry: the north port hides behind
      // the fireplace, so it gets NO click box and NO isDoorBody tags —
      // otherwise fireplace clicks would trigger it.
      const walkable = findDoor(cfg.id)?.enabled === true;
      const bodyData = { isDoorBody: true, doorId: cfg.id };

      // Local geometry conventions: group centre sits at world y=2, so the
      // floor is local y=-2. Opening = 1.4w x 3.0h (small) / 2.4w x 3.0h (large).
      const openingWidth = cfg.isLarge ? 2.4 : 1.4;
      const OPEN_H = 3.0;      // opening height (local y -2 .. 1)
      const POST_W = 0.3;      // side post width
      const FRAME_D = 0.5;     // frame depth
      const FLOOR_Y = -2;      // local floor level

      // ── 1. Frame: two grounded side posts + header (gunmetal) ──────────────
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x2A3444, roughness: 0.6, metalness: 0.35 });
      const postGeo = new THREE.BoxGeometry(POST_W, OPEN_H, FRAME_D);
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, frameMat);
        post.position.set(side * (openingWidth / 2 + POST_W / 2), FLOOR_Y + OPEN_H / 2, 0);
        if (walkable) post.userData = { ...bodyData };
        doorGroup.add(post);
      }
      const header = new THREE.Mesh(
        new THREE.BoxGeometry(openingWidth + POST_W * 2, 0.5, FRAME_D),
        frameMat,
      );
      header.position.set(0, FLOOR_Y + OPEN_H + 0.25, 0);
      if (walkable) header.userData = { ...bodyData };
      doorGroup.add(header);

      // ── 2. Emissive frame strips (status-tinted via syncLEDStatus) ─────────
      const glowMat = new THREE.MeshBasicMaterial({ color: 0x00E5FF });
      for (const side of [-1, 1]) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.06, OPEN_H, 0.06), glowMat);
        strip.position.set(side * (openingWidth / 2 + 0.03), FLOOR_Y + OPEN_H / 2, FRAME_D / 2);
        strip.name = 'frameGlow';
        doorGroup.add(strip);
      }
      const headerStrip = new THREE.Mesh(new THREE.BoxGeometry(openingWidth, 0.06, 0.06), glowMat);
      headerStrip.position.set(0, FLOOR_Y + OPEN_H + 0.03, FRAME_D / 2);
      headerStrip.name = 'frameGlow';
      doorGroup.add(headerStrip);

      // ── 3. Leaves as groups (slide code only touches .position.x) ──────────
      const leafWidth = openingWidth / 2;
      const steelMat   = new THREE.MeshStandardMaterial({ color: 0x37474F, roughness: 0.5, metalness: 0.55 });
      const grooveMat  = new THREE.MeshStandardMaterial({ color: 0x1C262E, roughness: 0.85, metalness: 0.2 });
      const slitMat    = new THREE.MeshBasicMaterial({ color: 0x9BE7FF });
      const chevronMat = new THREE.MeshStandardMaterial({ color: 0xD4A84B, roughness: 0.4, metalness: 0.5 });
      const kickMat    = new THREE.MeshStandardMaterial({ color: 0x10161D, roughness: 0.9, metalness: 0.1 });

      const buildLeaf = (name: 'leftLeaf' | 'rightLeaf', closedOffset: number): THREE.Group => {
        const leaf = new THREE.Group();
        leaf.name = name;
        // Grounded: panel spans local y -2 .. 1
        leaf.position.set(closedOffset, FLOOR_Y + OPEN_H / 2, 0.05);
        const inner = name === 'leftLeaf' ? 1 : -1; // toward the centre seam

        // Base steel panel
        const panel = new THREE.Mesh(new THREE.BoxGeometry(leafWidth, OPEN_H, 0.15), steelMat);
        leaf.add(panel);

        // Recessed groove strips
        for (const gy of [1.05, 0.55, -0.65]) {
          const groove = new THREE.Mesh(new THREE.BoxGeometry(leafWidth - 0.12, 0.05, 0.02), grooveMat);
          groove.position.set(0, gy, 0.075);
          leaf.add(groove);
        }

        // Vertical emissive window slit at the INNER edge — the closed door
        // reads as a lit centre seam.
        const slit = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, 0.03), slitMat);
        slit.position.set(inner * (leafWidth / 2 - 0.07), 0, 0.08);
        leaf.add(slit);

        // Amber chevron plate, angled toward the seam
        const chevron = new THREE.Mesh(new THREE.BoxGeometry(leafWidth * 0.55, 0.16, 0.02), chevronMat);
        chevron.position.set(0, -1.0, 0.08);
        chevron.rotation.z = inner * 0.5;
        leaf.add(chevron);

        // Dark kick plate near the bottom
        const kick = new THREE.Mesh(new THREE.BoxGeometry(leafWidth, 0.35, 0.03), kickMat);
        kick.position.set(0, -OPEN_H / 2 + 0.2, 0.08);
        leaf.add(kick);

        if (walkable) {
          leaf.children.forEach((child) => { child.userData = { ...bodyData }; });
        }
        return leaf;
      };

      const leftOffset = cfg.isLarge ? -0.62 : -0.37;
      const rightOffset = cfg.isLarge ? 0.62 : 0.37;
      doorGroup.add(buildLeaf('leftLeaf', leftOffset));
      doorGroup.add(buildLeaf('rightLeaf', rightOffset));

      // ── 4. Floor threshold plate + emissive guide strips ───────────────────
      const threshold = new THREE.Mesh(
        new THREE.BoxGeometry(openingWidth + 0.6, 0.04, 0.9),
        new THREE.MeshStandardMaterial({ color: 0x232E3A, roughness: 0.7, metalness: 0.3 }),
      );
      threshold.position.set(0, -1.98, 0);
      doorGroup.add(threshold);
      for (const gz of [-0.35, 0.35]) {
        const guide = new THREE.Mesh(new THREE.BoxGeometry(openingWidth + 0.5, 0.015, 0.05), glowMat);
        guide.position.set(0, -1.95, gz);
        guide.name = 'frameGlow';
        doorGroup.add(guide);
      }

      // ── 5. Invisible click box covering the doorway (walkable doors only) ──
      if (walkable) {
        const clickBox = new THREE.Mesh(
          new THREE.BoxGeometry(openingWidth + 0.6, 3.4, 0.5),
          new THREE.MeshBasicMaterial({ visible: false }),
        );
        clickBox.position.set(0, -0.3, 0);
        clickBox.userData = { ...bodyData };
        doorGroup.add(clickBox);
      }

      // We attach the isLarge metadata onto the group so our slider knows the correct target panning offsets
      doorGroup.userData = { isLarge: cfg.isLarge };

      // 3. Interactive Keypad Box (Golden terminal highlight)
      const keypadGeo = new THREE.BoxGeometry(0.3, 0.4, 0.12);
      const keypadMat = new THREE.MeshStandardMaterial({ color: 0xD4A84B, metalness: 0.5 });
      const keypad = new THREE.Mesh(keypadGeo, keypadMat);
      const keypadOffsetX = cfg.isLarge ? 1.6 : 1.1;
      keypad.position.set(keypadOffsetX, -0.2, 0.1);
      keypad.name = `keypad_${cfg.id}`;
      // Store reference inside trigger metadata
      keypad.userData = { isControlPanel: true, doorId: cfg.id };
      doorGroup.add(keypad);

      // 4. Status Indicator LED Sphere
      const ledGeo = new THREE.SphereGeometry(0.06, 16, 16);
      const ledMat = new THREE.MeshBasicMaterial({ color: 0xFF1744 }); // Default locked/red indicator
      const led = new THREE.Mesh(ledGeo, ledMat);
      led.position.set(keypadOffsetX, 0.1, 0.18);
      led.name = 'ledStatus';
      doorGroup.add(led);

      this.roomsGroup.add(doorGroup);
      this.doorObjects.set(cfg.id, doorGroup);

      // Paint LED + frame glow from the door's initial state
      const state = this.doorState.get(cfg.id);
      if (state) this.syncLEDStatus(cfg.id, state);
    }

    this.mountInterfaceControlPanel();
  }

  /**
   * Mount floating interactive terminal to manage Room addresses, Pin-codes and pairings
   */
  private mountInterfaceControlPanel() {
    const pane = document.createElement('div');
    pane.id = 'docking-control-pane';
    pane.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 380px;
      background: rgba(4, 8, 22, 0.95);
      border: 1px solid rgba(212, 168, 75, 0.28);
      border-radius: 12px;
      box-shadow: 0 12px 64px rgba(0,0,0,0.9);
      padding: 24px;
      display: none;
      flex-direction: column;
      gap: 16px;
      color: #d4a84b;
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      z-index: 6000;
      box-sizing: border-box;
    `;

    pane.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:10px;">
        <span id="docking-pane-title" style="font-size:12px; font-weight:800; color:#F0C060; letter-spacing:1px;">🚪 DOCKING PORT CONTROL</span>
        <button id="docking-close-btn" style="background:rgba(212,168,75,0.1); border:1px solid rgba(212,168,75,0.3); border-radius:6px; color:#d4a84b; font-size:10px; padding:4px 8px; cursor:pointer;">X</button>
      </div>

      <div style="display:flex; flex-direction:column; gap:12px; font-size:11px;">
        <!-- Lock config -->
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span>LOCK STATE CONFIG:</span>
          <button id="docking-lock-toggle" style="background:#ff1744; border:none; border-radius:4px; color:#fff; font-weight:bold; padding:4px 10px; cursor:pointer;">LOCKED</button>
        </div>

        <div>
          <label style="display:block; margin-bottom:4px; color:rgba(212,168,75,0.6);">SECURITY PIN CODE:</label>
          <input type="text" id="docking-pin-input" placeholder="e.g. 1106" style="width:100%; border-radius:6px; border:1px solid rgba(212,168,75,0.18); background:rgba(0,0,0,0.3); color:#d4a84b; padding:6px 10px; font-size:11px; outline:none; font-family:monospace;">
        </div>

        <!-- Connection address -->
        <div>
          <label style="display:block; margin-bottom:4px; color:rgba(212,168,75,0.6);">TARGET CONNECTED ROOM ADDRESS:</label>
          <input type="text" id="docking-addr-input" placeholder="Paste target seed link..." style="width:100%; border-radius:6px; border:1px solid rgba(212,168,75,0.18); background:rgba(0,0,0,0.3); color:#d4a84b; padding:6px 10px; font-size:11px; outline:none; font-family:monospace;">
        </div>

        <button id="docking-request-btn" style="width:100%; border-radius:6px; border:1px solid #1e88e5; background:rgba(30,136,229,0.15); color:#90caf9; padding:8px; font-weight:bold; cursor:pointer; text-transform:uppercase;">INITIATE PORT PLUG PAIRING</button>
      </div>

      <!-- Pairing notifications -->
      <div id="docking-pairing-box" style="display:none; flex-direction:column; gap:8px; border-top:1px solid rgba(212,168,75,0.18); padding-top:10px; margin-top:5px;">
        <span style="font-size:10px; color:#ffb300; font-weight:800; animation: blink 1.5s infinite;">⚠️ INBOUND CONNECTION REQUEST DETECTED</span>
        <span style="font-size:9.5px; color:rgba(212,168,75,0.7); line-height:1.3;">A remote clone capsule wishes to dock with your terminal. Accept pairing?</span>
        <div style="display:flex; gap:8px;">
          <button id="docking-accept-btn" style="flex:1; background:#00e676; border:none; border-radius:4px; color:#01020a; font-weight:bold; padding:6px; cursor:pointer; font-size:10px;">ACCEPT</button>
          <button id="docking-reject-btn" style="flex:1; background:#ff1744; border:none; border-radius:4px; color:#fff; font-weight:bold; padding:6px; cursor:pointer; font-size:10px;">REJECT</button>
        </div>
      </div>
    `;

    document.body.appendChild(pane);
    this.setupPanelListeners();
  }

  private setupPanelListeners() {
    const closeBtn = document.getElementById('docking-close-btn');
    const lockBtn = document.getElementById('docking-lock-toggle');
    const requestBtn = document.getElementById('docking-request-btn');
    const acceptBtn = document.getElementById('docking-accept-btn');
    const rejectBtn = document.getElementById('docking-reject-btn');
    const box = document.getElementById('docking-control-pane');
    
    if (closeBtn) closeBtn.addEventListener('click', () => { if (box) box.style.display = 'none'; });

    // Handle clicks inside the modal to prevent passing them to 3D world floor clicks
    box?.addEventListener('click', (e) => e.stopPropagation());

    // Toggle Port Lock State
    if (lockBtn) {
      lockBtn.addEventListener('click', () => {
        const pane = document.getElementById('docking-control-pane');
        const activeDoorId = pane ? (pane as any).activeDoorId : null;
        if (!activeDoorId) return;
        const state = this.doorState.get(activeDoorId);
        if (state) {
          state.locked = !state.locked;
          lockBtn.textContent = state.locked ? 'LOCKED' : 'UNLOCKED';
          lockBtn.style.background = state.locked ? '#ff1744' : '#00e676';
          lockBtn.style.color = state.locked ? '#fff' : '#01020a';
          this.syncLEDStatus(activeDoorId, state);
          if (state.locked) this.closeDoor(activeDoorId);
          else this.openDoor(activeDoorId);
        }
      });
    }

    // Initiate pairings
    if (requestBtn) {
      requestBtn.addEventListener('click', () => {
        const pane = document.getElementById('docking-control-pane');
        const activeDoorId = pane ? (pane as any).activeDoorId : null;
        if (!activeDoorId) return;
        const state = this.doorState.get(activeDoorId);
        const addrInput = document.getElementById('docking-addr-input') as HTMLInputElement | null;
        const pinInput = document.getElementById('docking-pin-input') as HTMLInputElement | null;
        
        if (state && addrInput && pinInput) {
          state.connectedRoomAddress = addrInput.value.trim();
          state.pinCode = pinInput.value.trim();
          
          if (!state.connectedRoomAddress) {
            alert('Please paste a target room seed link first!');
            return;
          }

          state.pairingPending = true;
          this.syncLEDStatus(activeDoorId, state);
          
          if (this.onConnectionRequestCallback) {
            this.onConnectionRequestCallback(activeDoorId, state.connectedRoomAddress);
          }
          if (box) box.style.display = 'none';
        }
      });
    }

    // Accept / Reject inbound pairings
    if (acceptBtn) {
      acceptBtn.addEventListener('click', () => {
        const pane = document.getElementById('docking-control-pane');
        const activeDoorId = pane ? (pane as any).activeDoorId : null;
        if (!activeDoorId) return;
        this.completePairing(activeDoorId, true);
        if (box) box.style.display = 'none';
      });
    }

    if (rejectBtn) {
      rejectBtn.addEventListener('click', () => {
        const pane = document.getElementById('docking-control-pane');
        const activeDoorId = pane ? (pane as any).activeDoorId : null;
        if (!activeDoorId) return;
        this.completePairing(activeDoorId, false);
        if (box) box.style.display = 'none';
      });
    }
  }

  /**
   * Handle Click Raycasts originating in Three.js coordinates
   */
  public handlePanelRaycast(doorId: 'north' | 'south' | 'east' | 'west') {
    const pane = document.getElementById('docking-control-pane');
    const title = document.getElementById('docking-pane-title');
    const lockBtn = document.getElementById('docking-lock-toggle');
    const pinInput = document.getElementById('docking-pin-input') as HTMLInputElement | null;
    const addrInput = document.getElementById('docking-addr-input') as HTMLInputElement | null;
    const noticeBox = document.getElementById('docking-pairing-box');

    if (!pane || !title || !lockBtn || !pinInput || !addrInput || !noticeBox) return;

    // Load active settings for this door
    const state = this.doorState.get(doorId);
    if (!state) return;

    // Expose active door context inside the modal scope
    (pane as any).activeDoorId = doorId;
    pane.style.display = 'flex';
    title.textContent = `🚪 DOCKING PORT CONTROL: ${doorId.toUpperCase()}`;
    
    // Set field states
    lockBtn.textContent = state.locked ? 'LOCKED' : 'UNLOCKED';
    lockBtn.style.background = state.locked ? '#ff1744' : '#00e676';
    lockBtn.style.color = state.locked ? '#fff' : '#01020a';
    pinInput.value = state.pinCode;
    addrInput.value = state.connectedRoomAddress;

    // If there is an active inbound pairing request, reveal target controls
    if (state.pairingPending && !state.pairedSuccessfully) {
      noticeBox.style.display = 'flex';
    } else {
      noticeBox.style.display = 'none';
    }
  }

  /**
   * Sync Status LED spheres in 3D coordinates based on locks and pairing
   * signals, and tint the emissive 'frameGlow' strips to match:
   * pending amber, paired green, locked red, otherwise cyan.
   */
  private syncLEDStatus(doorId: 'north' | 'south' | 'east' | 'west', state: DockingState) {
    const group = this.doorObjects.get(doorId);
    if (!group) return;

    let ledColor = 0x1E88E5;  // Blue (idle/unlocked)
    let glowColor = 0x00E5FF; // Cyan (idle/unlocked)
    if (state.pairingPending && !state.pairedSuccessfully) {
      ledColor = 0xFFB300; glowColor = 0xFFB300;  // Yellow/Orange
    } else if (state.pairedSuccessfully) {
      ledColor = 0x00E676; glowColor = 0x00E676;  // Green
    } else if (state.locked) {
      ledColor = 0xFF1744; glowColor = 0xFF1744;  // Red
    }

    const led = group.getObjectByName('ledStatus') as THREE.Mesh | undefined;
    if (led && led.material instanceof THREE.MeshBasicMaterial) {
      led.material.color.setHex(ledColor);
    }

    group.traverse((child) => {
      if (child.name === 'frameGlow') {
        const mat = (child as THREE.Mesh).material;
        if (mat instanceof THREE.MeshBasicMaterial) mat.color.setHex(glowColor);
      }
    });
  }

  /**
   * Execute inbound request triggers
   */
  public receiveInboundPairingRequest(doorId: 'north' | 'south' | 'east' | 'west', targetAddr: string) {
    const state = this.doorState.get(doorId);
    if (state) {
      state.connectedRoomAddress = targetAddr;
      state.pairingPending = true;
      this.syncLEDStatus(doorId, state);
      
      // Start Flash LED animation inside tick
      this.animateBlinkingIndicator(doorId);
    }
  }

  private animateBlinkingIndicator(doorId: 'north' | 'south' | 'east' | 'west') {
    let toggle = false;
    const interval = setInterval(() => {
      const state = this.doorState.get(doorId);
      if (!state || !state.pairingPending || state.pairedSuccessfully) {
        clearInterval(interval);
        return;
      }

      const group = this.doorObjects.get(doorId);
      const led = group?.getObjectByName('ledStatus') as THREE.Mesh | undefined;
      if (led && led.material instanceof THREE.MeshBasicMaterial) {
        toggle = !toggle;
        led.material.color.setHex(toggle ? 0xFFB300 : 0x111625); // flash yellow vs dark
      }
    }, 450);
  }

  public completePairing(doorId: 'north' | 'south' | 'east' | 'west', accept: boolean) {
    const state = this.doorState.get(doorId);
    if (!state) return;

    state.pairingPending = false;
    state.pairedSuccessfully = accept;
    
    if (accept) {
      state.locked = false; // Open door on success
      this.syncLEDStatus(doorId, state);
      this.drawAdjacentRoomProjection(doorId);
      this.openDoor(doorId);
    } else {
      state.connectedRoomAddress = '';
      this.syncLEDStatus(doorId, state);
    }

    if (this.onPairingStatusChangedCallback) {
      this.onPairingStatusChangedCallback(doorId, accept ? 'ACCEPTED' : 'REJECTED');
    }
  }

  /**
   * Request the door leaves to slide open. onComplete fires exactly once when
   * both leaves reach the open position. A newer opposite-direction request
   * on the same door overwrites the in-flight slide (its onComplete is
   * dropped); a same-direction request chains the callbacks instead.
   */
  public openDoor(doorId: DoorId, onComplete?: () => void): void {
    this.startSlide(doorId, true, onComplete);
  }

  /** Request the door leaves to slide closed. */
  public closeDoor(doorId: DoorId, onComplete?: () => void): void {
    this.startSlide(doorId, false, onComplete);
  }

  private startSlide(doorId: DoorId, open: boolean, onComplete?: () => void): void {
    const group = this.doorObjects.get(doorId);
    if (!group) return; // no door built — the caller's timeout handles it
    const isLarge = group.userData?.isLarge === true;
    const openTarget = open ? (isLarge ? 1.8 : 1.05) : (isLarge ? 0.62 : 0.37);

    // Same-direction overwrite: chain the in-flight onComplete (old first) so
    // an external open (keypad unlock, pairing accept) can't drop a waiting
    // player's door-opened callback. Opposite-direction overwrites still drop
    // the old callback — that completion will never be reached.
    const prev = this.slideAnims.get(doorId);
    if (prev && prev.openTarget === openTarget && prev.onComplete) {
      const prevCb = prev.onComplete;
      const nextCb = onComplete;
      onComplete = nextCb ? () => { prevCb(); nextCb(); } : prevCb;
    }

    this.slideAnims.set(doorId, { openTarget, onComplete });
  }

  /**
   * Advance in-flight leaf slides. Driven from World.update — no detached
   * requestAnimationFrame loops, so completion can be signalled reliably.
   */
  public update(deltaTime: number): void {
    if (this.slideAnims.size === 0) return;
    for (const [doorId, anim] of Array.from(this.slideAnims.entries())) {
      const group = this.doorObjects.get(doorId);
      const left = group?.getObjectByName('leftLeaf');
      const right = group?.getObjectByName('rightLeaf');
      if (!left || !right) {
        this.slideAnims.delete(doorId);
        continue;
      }
      const step = this.SLIDE_SPEED * deltaTime;
      left.position.x  = moveToward(left.position.x,  -anim.openTarget, step);
      right.position.x = moveToward(right.position.x,  anim.openTarget, step);
      if (
        Math.abs(left.position.x + anim.openTarget) < 0.01 &&
        Math.abs(right.position.x - anim.openTarget) < 0.01
      ) {
        left.position.x  = -anim.openTarget;
        right.position.x =  anim.openTarget;
        this.slideAnims.delete(doorId);
        if (anim.onComplete) anim.onComplete();
      }
    }
  }

  /** Read-only access to a door's docking state (doorState map is private). */
  public getDockingState(doorId: DoorId): DockingState | null {
    return this.doorState.get(doorId) ?? null;
  }

  /**
   * Render "Gray Box" Projection of the connected room outside the doorway
   */
  private drawAdjacentRoomProjection(doorId: 'north' | 'south' | 'east' | 'west') {
    if (this.adjacentRooms.has(doorId)) return;

    // Establish scale boundaries equal to active lounge (12x12 plane)
    const roomGeo = new THREE.BoxGeometry(11.8, 4.0, 11.8);
    // Translucent grey wireframe box represents the un-rendered, connected remote room
    const roomMat = new THREE.MeshStandardMaterial({
      color: 0x5a5d64,
      roughness: 0.9,
      transparent: true,
      opacity: 0.45,
      wireframe: false,
    });
    
    const adjRoom = new THREE.Mesh(roomGeo, roomMat);
    
    // Position adjacent room directly outside the corresponding doorway wall
    const offset = 12.0; // wall to wall center offset
    switch (doorId) {
      case 'north': adjRoom.position.set(0, 2, -offset); break;
      case 'south': adjRoom.position.set(0, 2, offset); break;
      case 'west': adjRoom.position.set(-offset, 2, 0); break;
      case 'east': adjRoom.position.set(offset, 2, 0); break;
    }

    this.roomsGroup.add(adjRoom);
    this.adjacentRooms.set(doorId, adjRoom);
    
    console.log(`📡 Rendered "Gray Box" projection of external capsule outside ${doorId.toUpperCase()} portal`);
  }

  // Bind Listeners
  public onConnectionRequest(cb: (doorId: string, address: string) => void) {
    this.onConnectionRequestCallback = cb;
  }

  public onPairingStatusChanged(cb: (doorId: string, status: string) => void) {
    this.onPairingStatusChangedCallback = cb;
  }
}
