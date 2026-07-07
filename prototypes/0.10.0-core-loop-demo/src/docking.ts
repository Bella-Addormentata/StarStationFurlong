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
   */
  public buildPorts() {
    console.log('🚪 Constructing 4-Directional Docking Ports & Control Panels');
    
    // Configurations: [doorId, pos, rot]
    const doorsConfig: Array<{ id: 'north' | 'south' | 'east' | 'west'; pos: THREE.Vector3; rotY: number }> = [
      { id: 'north', pos: new THREE.Vector3(0, 2, -6), rotY: 0 },
      { id: 'south', pos: new THREE.Vector3(0, 2, 6), rotY: Math.PI },
      { id: 'west', pos: new THREE.Vector3(-6, 2, 0), rotY: Math.PI / 2 },
      { id: 'east', pos: new THREE.Vector3(6, 2, 0), rotY: -Math.PI / 2 },
    ];

    for (const cfg of doorsConfig) {
      const doorGroup = new THREE.Group();
      doorGroup.position.copy(cfg.pos);
      doorGroup.rotation.y = cfg.rotY;

      // 1. Frame Frame Geometries (sleek space-carbon look)
      const frameGeo = new THREE.BoxGeometry(3.0, 3.5, 0.4);
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x111625, roughness: 0.8 });
      const frame = new THREE.Mesh(frameGeo, frameMat);
      doorGroup.add(frame);

      // 2. Door Panels (moving metal blocks)
      const leafGeo = new THREE.BoxGeometry(1.2, 3.2, 0.15);
      const leafMat = new THREE.MeshStandardMaterial({ color: 0x1E88E5, metalness: 0.1, roughness: 0.5 });
      
      const leftLeaf = new THREE.Mesh(leafGeo, leafMat);
      leftLeaf.position.set(-0.62, 0, 0.05);
      leftLeaf.name = 'leftLeaf';
      
      const rightLeaf = new THREE.Mesh(leafGeo, leafMat);
      rightLeaf.position.set(0.62, 0, 0.05);
      rightLeaf.name = 'rightLeaf';

      doorGroup.add(leftLeaf);
      doorGroup.add(rightLeaf);

      // 3. Interactive Keypad Box (Golden terminal highlight)
      const keypadGeo = new THREE.BoxGeometry(0.3, 0.4, 0.12);
      const keypadMat = new THREE.MeshStandardMaterial({ color: 0xD4A84B, metalness: 0.5 });
      const keypad = new THREE.Mesh(keypadGeo, keypadMat);
      keypad.position.set(1.6, -0.2, 0.1);
      keypad.name = `keypad_${cfg.id}`;
      // Store reference inside trigger metadata
      keypad.userData = { isControlPanel: true, doorId: cfg.id };
      doorGroup.add(keypad);

      // 4. Status Indicator LED Sphere
      const ledGeo = new THREE.SphereGeometry(0.06, 16, 16);
      const ledMat = new THREE.MeshBasicMaterial({ color: 0xFF1744 }); // Default locked/red indicator
      const led = new THREE.Mesh(ledGeo, ledMat);
      led.position.set(1.6, 0.1, 0.18);
      led.name = 'ledStatus';
      doorGroup.add(led);

      this.roomsGroup.add(doorGroup);
      this.doorObjects.set(cfg.id, doorGroup);
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
          this.animateDoorSlides(activeDoorId, !state.locked);
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
   * Sync Status LED spheres in 3D coordinates based on locks and pairing signals
   */
  private syncLEDStatus(doorId: 'north' | 'south' | 'east' | 'west', state: DockingState) {
    const group = this.doorObjects.get(doorId);
    if (!group) return;

    const led = group.getObjectByName('ledStatus') as THREE.Mesh | undefined;
    if (led && led.material instanceof THREE.MeshBasicMaterial) {
      if (state.pairingPending && !state.pairedSuccessfully) {
        led.material.color.setHex(0xFFB300); // Yellow/Orange
      } else if (state.pairedSuccessfully) {
        led.material.color.setHex(0x00E676); // Green
      } else if (state.locked) {
        led.material.color.setHex(0xFF1744); // Red
      } else {
        led.material.color.setHex(0x1E88E5); // Blue
      }
    }
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
      this.animateDoorSlides(doorId, true);
    } else {
      state.connectedRoomAddress = '';
      this.syncLEDStatus(doorId, state);
    }

    if (this.onPairingStatusChangedCallback) {
      this.onPairingStatusChangedCallback(doorId, accept ? 'ACCEPTED' : 'REJECTED');
    }
  }

  /**
   * Slide door panels open/closed
   */
  private animateDoorSlides(doorId: 'north' | 'south' | 'east' | 'west', open: boolean) {
    const group = this.doorObjects.get(doorId);
    if (!group) return;

    const left = group.getObjectByName('leftLeaf') as THREE.Mesh | undefined;
    const right = group.getObjectByName('rightLeaf') as THREE.Mesh | undefined;

    if (left && right) {
      const targetOffset = open ? 1.45 : 0.62;
      let cur = 0;
      const step = () => {
        cur += 0.05;
        left.position.x = THREE.MathUtils.lerp(left.position.x, -targetOffset, 0.15);
        right.position.x = THREE.MathUtils.lerp(right.position.x, targetOffset, 0.15);
        if (cur < 1.0) requestAnimationFrame(step);
      };
      step();
    }
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
