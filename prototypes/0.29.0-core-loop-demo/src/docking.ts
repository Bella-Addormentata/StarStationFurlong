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
import { getCameraYaw } from './cameraRig';
import { projectionPoseForDoor, solveChain, foldChainEnd, type ConnectorSegment } from './adapter';
// 🛰️ Hull space: built chains register their swept boxes so exterior mounts
// can't be placed through a vestibule — and the assembly UI warns the other
// way when a chain would run through mounted equipment.
import { setChainBoxProvider, exteriorItemBoxes } from './hull';
import type { Box } from './furniture';
import {
  armedPreset, presetSegments, partsCount, consumePart, refundPart,
  consumeForSegments, refundForSegments,
} from './stationParts';
import {
  readDoorPolicy, writeDoorPolicy, passageLabel, readDoorRequests, readDoorGrants,
  writeDoorRequest, removeDoorRequest, writeDoorGrant, removeDoorGrant,
  hasDoorGrant, hasDoorRequest, type ConstructionMode, type DoorPolicyRecord,
} from './doorPolicy';
import { getIdentityPub } from './keypair';
import { getPlayerName } from './identity';
import { deleteDoorPairing } from './doorsDoc';
import {
  seedFloorPlan, writeDoorPlacement, readDoorDeltas, lateralOf,
  LEGACY_PLACEMENTS, DOOR_LATTICE,
} from './floorPlanDoc';
import { physicalDoorPose } from './doorLayout';
import { readAtlas, atlasLayout } from './stationAtlas';

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
  /** #62 P2 (optional — absent on legacy pairings): the connection's assembled
   *  connector chain + far-side geometry, mirrored from the doors doc. P3
   *  renders the chain + poses the projection from these; P2 only stores/diffs. */
  segments?: ConnectorSegment[];
  farDoor?: 'north' | 'south' | 'east' | 'west';
  farYawDeg?: 0 | 45;
  /** #67 D2: this pairing is a TRANSIENT guest berth (docking adapter). */
  transient?: boolean;
}

export class DoorDockingPortSystem {
  private roomsGroup: THREE.Group;
  private doorState: Map<'north' | 'south' | 'east' | 'west', DockingState> = new Map();
  private doorObjects: Map<string, THREE.Group> = new Map();
  /** Room ENTRY policy (public doors) — distinct from the per-door pairing
   *  lock the terminal manages. Tints every door's status LED so the room's
   *  openness is legible at each threshold. Re-asserted on door (re)build. */
  private accessMode: 'public' | 'pass' | 'keyed' = 'pass';
  private adjacentRooms: Map<string, THREE.Mesh> = new Map();

  // ── Update-loop-driven leaf slides ─────────────────────────────────────────
  /** In-flight slide per door; a new open/close overwrites the entry. */
  private slideAnims = new Map<DoorId, { openTarget: number; onComplete?: () => void }>();
  /** Leaf slide speed (metres/second). */
  private readonly SLIDE_SPEED = 2.2;

  // ── Camera-facing door fade (#51) ──────────────────────────────────────────
  /**
   * Per-door deduped material lists for the screen-lower transparency fade.
   * Every door material is created inside buildPorts' per-door loop, so no
   * material is ever shared across doors — a per-door opacity write can't
   * bleed into a neighbour. The fade only touches `.opacity`/`.transparent`;
   * syncLEDStatus tints only `.color` — the two never fight.
   */
  private doorFadeMats: Map<DoorId, THREE.Material[]> = new Map();
  /** Current eased fade opacity per door (1 = solid). */
  private doorFadeOpacity: Map<DoorId, number> = new Map();
  /** Resting opacity of a camera-facing door in the isometric view. */
  private static readonly FACING_FADE_OPACITY = 0.35;
  /** Outward wall normals (XZ) — dot against the camera azimuth direction. */
  private static readonly DOOR_NORMALS: Record<DoorId, { x: number; z: number }> = {
    north: { x: 0, z: -1 },
    south: { x: 0, z: 1 },
    east:  { x: 1, z: 0 },
    west:  { x: -1, z: 0 },
  };
  
  // Handlers
  private onConnectionRequestCallback: ((doorId: string, address: string) => void) | null = null;
  private onPairingStatusChangedCallback: ((doorId: string, status: string) => void) | null = null;
  /** #62 P4: main.ts answers "may this address pair without a far-side human?"
   *  — true for modules THIS client minted (the ledger) when AUTO-ACCEPT MY
   *  MODULES is on. Removes 12 hop-accept-hop round trips from the octagon. */
  private autoAcceptCheckCallback: ((address: string) => boolean) | null = null;
  /** Owner gate (vestibule-findings fix): main.ts answers "is the LOCAL player
   *  this room's owner?" — connection changes (request/accept/assembly) are
   *  owner-only, same posture as edit mode. UI-level gating for the dev phase;
   *  read-side enforcement needs signed door records (a later slice). Default
   *  true when unwired so standalone/dev use keeps working. */
  private ownerCheckCallback: (() => boolean) | null = null;

  private isRoomOwner(): boolean {
    return this.ownerCheckCallback ? this.ownerCheckCallback() : true;
  }

  /** #67 D1: may the LOCAL player build (dock/assemble) at this door? Owner
   *  always; otherwise per the door's construction policy — 'public' opens it
   *  to everyone, 'request' honors a standing grant keyed to the player's
   *  identity pub, 'owner' refuses. */
  private canConstruct(doorId: string): boolean {
    if (this.isRoomOwner()) return true;
    const mode = readDoorPolicy(doorId).construction;
    if (mode === 'public') return true;
    if (mode === 'request') return hasDoorGrant(doorId, getIdentityPub());
    return false;
  }

  /** #67 D1: may the LOCAL player operate (lock/unlock) this door? Follows the
   *  PASSAGE policy — 'public' (default) keeps today's anyone-can behavior. */
  private canOperateDoor(doorId: string): boolean {
    return this.isRoomOwner() || readDoorPolicy(doorId).passage === 'public';
  }

  /** Vestibule-findings fix (ghost residue): doors whose chain came from the
   *  armed-preset PREFILL and was never touched by the user. Closing the pane
   *  with the prefill untouched refunds it — merely INSPECTING a keypad must
   *  not leave a ghost tube (or consume parts) as a side effect. Any deliberate
   *  edit or INITIATE clears the flag and the chain becomes intentional. */
  private untouchedPrefills = new Set<string>();
  /**
   * "Buy a module" v0 (T1 of issue #30): mints a fresh room seed against the
   * LOCAL node. Wired by main.ts (callback pattern — docking.ts must not
   * import main.ts). Resolves to the seed link, or null when the node is
   * unreachable.
   */
  private provisionModuleCallback: (() => Promise<string | null>) | null = null;

  constructor(roomsGroup: THREE.Group) {
    this.roomsGroup = roomsGroup;
    this.initializeDoorStates();
    // 🛰️ hull.ts occupancy: exterior-mount validation consults our built
    // chains (latest instance wins — exactly one system is live per room).
    setChainBoxProvider(() => this.builtChainBoxes());
  }

  /**
   * 🛰️ XZ boxes swept by every door's CURRENT chain, folded joint by joint
   * (chain-local frame → world via the door's face + yaw — the same
   * transform family as projectionPoseForDoor). Padded to the vestibule's
   * half-width so a mount can't sit flush against a tube wall either.
   */
  private builtChainBoxes(): Box[] {
    const out: Box[] = [];
    for (const doorId of this.doorState.keys()) {
      out.push(...this.chainBoxesFor(doorId));
    }
    return out;
  }

  /** One door's chain, folded joint by joint into padded world-XZ boxes. */
  private chainBoxesFor(doorId: 'north' | 'south' | 'east' | 'west'): Box[] {
    const segs = this.doorState.get(doorId)?.segments ?? [];
    if (segs.length === 0) return [];
    // Our door centre + outward normal come from the active layout; the chain
    // projects outward from there. Paired doors don't slide (delta 0).
    const pose = physicalDoorPose(doorId);
    const PAD = 0.85;
    const face = { x: pose.x, z: pose.z };
    const yaw = pose.outwardYaw;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const toWorld = (lx: number, lz: number) => ({
      x: face.x + lx * c + lz * s,
      z: face.z - lx * s + lz * c,
    });
    const out: Box[] = [];
    let prev = toWorld(0, 0);
    for (let i = 1; i <= segs.length; i++) {
      const p = foldChainEnd(segs.slice(0, i));
      const cur = toWorld(p.x, p.z);
      out.push({
        x0: Math.min(prev.x, cur.x) - PAD, z0: Math.min(prev.z, cur.z) - PAD,
        x1: Math.max(prev.x, cur.x) + PAD, z1: Math.max(prev.z, cur.z) + PAD,
      });
      prev = cur;
    }
    return out;
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
    
    // Door position + frame yaw come from the active layout (doorLayout.ts), so
    // they follow the room size and any layout swap. Default 2×2 legacy room ⇒
    // the legacy ±6 positions / cardinal yaws, bit-for-bit.
    const doorsConfig: Array<{ id: 'north' | 'south' | 'east' | 'west'; isLarge: boolean }> = [
      { id: 'north', isLarge: false }, // Small door (1.0m width)
      { id: 'south', isLarge: false }, // Small door (1.0m width)
      { id: 'west', isLarge: true },   // Large door (2.0m width)
      { id: 'east', isLarge: true },   // Large door (2.0m width)
    ];

    for (const cfg of doorsConfig) {
      const pose = physicalDoorPose(cfg.id);
      const doorGroup = new THREE.Group();
      doorGroup.position.set(pose.x, 2, pose.z);
      doorGroup.rotation.y = pose.frameYaw;

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

      // #51: collect this door's materials for the camera-facing fade.
      // Dedupe (one material serves several meshes within the door) and skip
      // the invisible click box (its material must stay untouched).
      const fadeMats: THREE.Material[] = [];
      const seenMats = new Set<THREE.Material>();
      doorGroup.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          if (!mat || mat.visible === false || seenMats.has(mat)) continue;
          seenMats.add(mat);
          fadeMats.push(mat);
        }
      });
      this.doorFadeMats.set(cfg.id, fadeMats);
      this.doorFadeOpacity.set(cfg.id, 1);

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

        <!-- #62 P4: CONNECTION ASSEMBLY — chain chips + far-side controls.
             Parts come from the DEV PARTS inventory; the armed preset prefills
             on pane open. The chain renders in-world as a ghost while unpaired
             and publishes with the pairing record (P2/P3 machinery). -->
        <div id="docking-assembly" style="border-top:1px solid rgba(212,168,75,0.14); padding-top:10px;">
          <label style="display:block; margin-bottom:4px; color:rgba(212,168,75,0.6);">CONNECTION ASSEMBLY <span id="docking-parts-note" style="color:rgba(212,168,75,0.38); font-size:9px;"></span></label>
          <div id="docking-chips" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px; min-height:20px;"></div>
          <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
            <button id="docking-add-flex" style="background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:#d4a84b; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">+FLEX</button>
            <button id="docking-add-ext" style="background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:#d4a84b; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">+EXT</button>
            <button id="docking-clear-chain" style="background:rgba(255,23,68,0.08); border:1px solid rgba(255,23,68,0.3); border-radius:5px; color:#ff8a80; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">CLEAR</button>
            <span style="flex:1;"></span>
            <span style="font-size:9px; color:rgba(212,168,75,0.55);">FAR:</span>
            <select id="docking-far-door" style="background:rgba(0,0,0,0.3); border:1px solid rgba(212,168,75,0.25); border-radius:5px; color:#d4a84b; font-size:9px; padding:2px 4px;">
              <option value="">auto</option>
              <option value="north">north</option>
              <option value="south">south</option>
              <option value="east">east</option>
              <option value="west">west</option>
            </select>
            <button id="docking-far-yaw" style="background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:#d4a84b; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">YAW —</button>
          </div>
          <!-- 🧲 Chain-contact detection (owner's ask): when the working chain's
               far end lands on a KNOWN module (station atlas), offer the
               connection right here. Rendered by detectChainContact. -->
          <div id="docking-dock-detect" style="display:none; margin-top:6px;"></div>
        </div>

        <!-- Connection address -->
        <div>
          <label style="display:block; margin-bottom:4px; color:rgba(212,168,75,0.6);">TARGET CONNECTED ROOM ADDRESS:</label>
          <input type="text" id="docking-addr-input" placeholder="Paste target seed link..." style="width:100%; border-radius:6px; border:1px solid rgba(212,168,75,0.18); background:rgba(0,0,0,0.3); color:#d4a84b; padding:6px 10px; font-size:11px; outline:none; font-family:monospace;">
          <!-- 🗺️ Known-modules picker (owner's 8th→1st finding): every module
               the station atlas has an address for, one tap to target — the
               close-the-ring flow without the zoom-out dance. -->
          <select id="docking-known-modules" style="width:100%; margin-top:5px; border-radius:6px; border:1px solid rgba(212,168,75,0.18); background:rgba(0,0,0,0.3); color:#d4a84b; padding:5px 8px; font-size:10px; outline:none;">
            <option value="">🗺️ … or pick a KNOWN MODULE</option>
          </select>
        </div>

        <!-- "Buy a module" v0 (T1 of #30): mint a fresh room on the local node
             and drop its seed into the address input, ready to pair. -->
        <button id="docking-provision-btn" style="width:100%; border-radius:6px; border:1px solid #d4a84b; background:rgba(212,168,75,0.12); color:#f0c060; padding:8px; font-weight:bold; cursor:pointer; text-transform:uppercase;">➕ PROVISION NEW MODULE</button>

        <button id="docking-request-btn" style="width:100%; border-radius:6px; border:1px solid #1e88e5; background:rgba(30,136,229,0.15); color:#90caf9; padding:8px; font-weight:bold; cursor:pointer; text-transform:uppercase;">INITIATE PORT PLUG PAIRING</button>

        <!-- #67 D1/D1b: per-door policy + rights requests — COLLAPSED by
             default (regression fix: this block above the assembly pushed the
             chain pills below the fold; assembly is the primary action, this
             is configuration). Rendered by renderPolicySection. -->
        <details id="docking-policy" style="border-top:1px solid rgba(212,168,75,0.14); padding-top:8px;">
          <summary style="cursor:pointer; color:rgba(212,168,75,0.6); font-size:10px; letter-spacing:1px; user-select:none;">⚙ DOOR POLICY · RIGHTS · POSITION</summary>
          <div id="docking-policy-body" style="display:flex; flex-direction:column; gap:6px; font-size:10px; margin-top:8px;"></div>
        </details>
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
    
    if (closeBtn) closeBtn.addEventListener('click', () => {
      // Ghost-residue fix: closing without using the prefilled chain refunds it.
      const pane = document.getElementById('docking-control-pane');
      const activeDoorId = pane ? (pane as any).activeDoorId : null;
      if (activeDoorId) this.discardUntouchedPrefill(activeDoorId);
      if (box) box.style.display = 'none';
    });

    // Handle clicks inside the modal to prevent passing them to 3D world floor clicks
    box?.addEventListener('click', (e) => e.stopPropagation());

    // Toggle Port Lock State
    if (lockBtn) {
      lockBtn.addEventListener('click', () => {
        const pane = document.getElementById('docking-control-pane');
        const activeDoorId = pane ? (pane as any).activeDoorId : null;
        if (!activeDoorId) return;
        // #67 D1: lock/unlock follows the PASSAGE policy (this control was
        // accidentally ungated before the policy work surfaced it).
        if (!this.canOperateDoor(activeDoorId)) {
          alert('This door\'s passage is owner-restricted.');
          return;
        }
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

    // Provision a fresh module room on the local node (T1 of #30) and fill
    // the address input with its seed — the user then pairs to it normally.
    const provisionBtn = document.getElementById('docking-provision-btn') as HTMLButtonElement | null;
    if (provisionBtn) {
      provisionBtn.addEventListener('click', async () => {
        if (!this.provisionModuleCallback) {
          alert('Module provisioning is not available (no local node wiring).');
          return;
        }
        const originalLabel = provisionBtn.textContent;
        provisionBtn.disabled = true;
        provisionBtn.textContent = 'MINTING MODULE…';
        try {
          const seed = await this.provisionModuleCallback();
          const addrInput = document.getElementById('docking-addr-input') as HTMLInputElement | null;
          if (seed && addrInput) {
            addrInput.value = seed;
          } else if (!seed) {
            alert('Could not mint a module seed — is the local node running?');
          }
        } finally {
          provisionBtn.disabled = false;
          provisionBtn.textContent = originalLabel;
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
        
        // #67 D1/D2: construction rights per the door's policy — EXCEPT at an
        // adapter door, where anyone may TRANSIENTLY berth a ship (no chains).
        if (activeDoorId && !this.canConstruct(activeDoorId)) {
          const berthState = this.doorState.get(activeDoorId);
          if (readDoorPolicy(activeDoorId).adapter && !(berthState?.segments?.length)) {
            if (berthState) berthState.transient = true; // guest berth, not construction
          } else {
            alert('No construction rights on this port — ask the owner (REQUEST BUILD RIGHTS below).');
            return;
          }
        } else if (activeDoorId) {
          const st = this.doorState.get(activeDoorId);
          if (st) st.transient = false; // rights-holder pairing = permanent structure
        }
        if (activeDoorId) this.untouchedPrefills.delete(activeDoorId); // INITIATE = intentional
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
          // #62 P4: modules this client minted pair instantly when auto-accept
          // is on — no far-side human exists for a freshly provisioned room.
          if (this.autoAcceptCheckCallback?.(state.connectedRoomAddress)) {
            this.completePairing(activeDoorId, true);
            console.log(`🤝 Auto-accepted pairing on ${activeDoorId} (own minted module).`);
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
        // #67 D1: approving a docking follows construction rights.
        if (!this.canConstruct(activeDoorId)) {
          alert('No construction rights on this port — ask the owner (REQUEST BUILD RIGHTS below).');
          return;
        }
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

    // ── #62 P4: CONNECTION ASSEMBLY wiring ──────────────────────────────────
    const activeDoor = (): ('north' | 'south' | 'east' | 'west') | null => {
      const pane = document.getElementById('docking-control-pane');
      return pane ? ((pane as any).activeDoorId ?? null) : null;
    };

    document.getElementById('docking-add-flex')?.addEventListener('click', () => {
      const doorId = activeDoor();
      const state = doorId ? this.doorState.get(doorId) : null;
      if (!doorId || !state || !this.canConstruct(doorId)) return;
      this.untouchedPrefills.delete(doorId); // deliberate edit — chain is intentional now
      if (!consumePart('flex')) { this.renderAssemblyStrip(doorId, 'no FLEX parts — DEV menu › PARTS'); return; }
      state.segments = [...(state.segments ?? []), { kind: 'flex', bendDeg: 0, stretch: 0 }];
      this.renderAssemblyStrip(doorId);
      this.publishIfPaired(doorId);
    });

    document.getElementById('docking-add-ext')?.addEventListener('click', () => {
      const doorId = activeDoor();
      const state = doorId ? this.doorState.get(doorId) : null;
      if (!doorId || !state || !this.canConstruct(doorId)) return;
      this.untouchedPrefills.delete(doorId);
      if (!consumePart('ext')) { this.renderAssemblyStrip(doorId, 'no EXTENSION parts — DEV menu › PARTS'); return; }
      state.segments = [...(state.segments ?? []), { kind: 'ext', bays: 4, skin: 'solid' }];
      this.renderAssemblyStrip(doorId);
      this.publishIfPaired(doorId);
    });

    document.getElementById('docking-clear-chain')?.addEventListener('click', () => {
      const doorId = activeDoor();
      const state = doorId ? this.doorState.get(doorId) : null;
      if (!doorId || !state || !this.canConstruct(doorId)) return;
      this.untouchedPrefills.delete(doorId);
      if (state.segments?.length) refundForSegments(state.segments);
      state.segments = undefined;
      this.renderAssemblyStrip(doorId);
      this.publishIfPaired(doorId);
    });

    // Chip interactions (delegated): cycle the main parameter, toggle skin,
    // or remove (with refund).
    document.getElementById('docking-chips')?.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-chip-action]');
      if (!el) return;
      const doorId = activeDoor();
      const state = doorId ? this.doorState.get(doorId) : null;
      const i = Number(el.dataset.i);
      if (!doorId || !state || !state.segments || !Number.isInteger(i) || !state.segments[i]) return;
      if (!this.canConstruct(doorId)) return;
      this.untouchedPrefills.delete(doorId);
      const seg = { ...state.segments[i] };
      const action = el.dataset.chipAction;
      if (action === 'remove') {
        refundPart(seg.kind === 'flex' ? 'flex' : 'ext');
        state.segments = state.segments.filter((_, k) => k !== i);
        if (state.segments.length === 0) state.segments = undefined;
      } else if (action === 'cycle') {
        if (seg.kind === 'flex') {
          const bends = [-45, -22.5, 0, 22.5, 45];
          const at = bends.indexOf(seg.bendDeg ?? 0);
          seg.bendDeg = bends[(at + 1 + bends.length) % bends.length];
        } else {
          const bays = [2, 4, 6, 8, 11];
          const at = bays.indexOf(seg.bays ?? 4);
          seg.bays = bays[(at + 1 + bays.length) % bays.length];
        }
        state.segments = state.segments.map((s, k) => (k === i ? seg : s));
      } else if (action === 'skin' && seg.kind === 'ext') {
        seg.skin = seg.skin === 'solid' ? 'ribbed' : 'solid';
        state.segments = state.segments.map((s, k) => (k === i ? seg : s));
      }
      this.renderAssemblyStrip(doorId);
      this.publishIfPaired(doorId);
    });

    (document.getElementById('docking-far-door') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
      const doorId = activeDoor();
      const state = doorId ? this.doorState.get(doorId) : null;
      if (!doorId || !state || !this.canConstruct(doorId)) return;
      const v = (e.target as HTMLSelectElement).value;
      state.farDoor = v === 'north' || v === 'south' || v === 'east' || v === 'west' ? v : undefined;
      this.publishIfPaired(doorId);
    });

    document.getElementById('docking-far-yaw')?.addEventListener('click', () => {
      const doorId = activeDoor();
      const state = doorId ? this.doorState.get(doorId) : null;
      if (!doorId || !state || !this.canConstruct(doorId)) return;
      // Cycle — → 0 → 45 → —
      state.farYawDeg = state.farYawDeg === undefined ? 0 : state.farYawDeg === 0 ? 45 : undefined;
      this.renderAssemblyStrip(doorId);
      this.publishIfPaired(doorId);
    });

    // 🗺️ Known-modules picker → fills the address input (repopulated on
    // every pane open by renderKnownModules).
    document.getElementById('docking-known-modules')?.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      const addrInput = document.getElementById('docking-addr-input') as HTMLInputElement | null;
      if (sel.value && addrInput) {
        addrInput.value = sel.value;
        addrInput.style.borderColor = 'rgba(0,230,118,0.7)';
        setTimeout(() => { addrInput.style.borderColor = ''; }, 1600);
      }
      sel.selectedIndex = 0; // reads as a menu, not a state
    });

    // ── #67 D1/D1b: DOOR POLICY actions (delegated) ─────────────────────────
    document.getElementById('docking-policy-body')?.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-policy-action]');
      if (!el) return;
      const doorId = activeDoor();
      if (!doorId) return;
      const action = el.dataset.policyAction;
      const pub = el.dataset.pub ?? '';
      if (action === 'req-build') {
        // Any player may ASK (that is the point) — their own client writes it.
        writeDoorRequest(doorId, getIdentityPub(), getPlayerName());
      } else if (action === 'detach-berth') {
        // #67 D2: EITHER side casts off a transient berth — no owner ceremony.
        // The doc delete reconciles to every client (projection torn down,
        // door re-locked) through the normal doors-doc path.
        deleteDoorPairing(doorId);
      } else if (!this.isRoomOwner()) {
        return; // every action below is owner-only (UI gate, dev-phase posture)
      } else if (action === 'cycle-passage') {
        // 🚪↦ Four states: PUBLIC (two-way) → IN ONLY → OUT ONLY → OWNER → …
        const p = readDoorPolicy(doorId);
        const next: DoorPolicyRecord = { ...p };
        if (p.passage === 'owner') { next.passage = 'public'; delete next.oneWay; }
        else if (!p.oneWay) { next.oneWay = 'in'; }
        else if (p.oneWay === 'in') { next.oneWay = 'out'; }
        else { next.passage = 'owner'; delete next.oneWay; }
        writeDoorPolicy(doorId, next);
      } else if (action === 'cycle-construction') {
        const p = readDoorPolicy(doorId);
        const next: Record<ConstructionMode, ConstructionMode> = { owner: 'request', request: 'public', public: 'owner' };
        writeDoorPolicy(doorId, { ...p, construction: next[p.construction] });
      } else if (action === 'slide-neg' || action === 'slide-pos') {
        // 🧱 #66 S1: slide the door 0.5 m along its wall. Owner-only (this
        // branch), UNPAIRED-only (plan §6.2 — live chains never re-solve),
        // snapped + clamped in floorPlanDoc on both write and read.
        const st2 = this.doorState.get(doorId);
        if (st2?.pairedSuccessfully) return;
        seedFloorPlan(); // lazy first-structure-commit seed (idempotent)
        const legacy = lateralOf(doorId, LEGACY_PLACEMENTS[doorId]);
        const current = legacy + (readDoorDeltas()[doorId] ?? 0);
        writeDoorPlacement(doorId, current + (action === 'slide-pos' ? DOOR_LATTICE : -DOOR_LATTICE));
      } else if (action === 'install-adapter') {
        // #67 D2: consumes an ADAPTER part; the flag is shared room truth.
        if (consumePart('adapter')) {
          writeDoorPolicy(doorId, { ...readDoorPolicy(doorId), adapter: true });
        }
      } else if (action === 'remove-adapter') {
        refundPart('adapter');
        writeDoorPolicy(doorId, { ...readDoorPolicy(doorId), adapter: false });
      } else if (action === 'accept-req' && pub) {
        writeDoorGrant(doorId, pub, el.dataset.name ?? 'Unknown-Clone');
      } else if (action === 'deny-req' && pub) {
        removeDoorRequest(doorId, pub);
      } else if (action === 'revoke-grant' && pub) {
        removeDoorGrant(doorId, pub);
      }
      this.renderPolicySection(doorId);
      this.renderAssemblyStrip(doorId); // a grant/mode change may unlock the strip
    });
  }

  /** #67 D1/D1b: paint the DOOR POLICY section (policy cycles for the owner;
   *  summary + request flow for guests; live request/grant lists). */
  private renderPolicySection(doorId: 'north' | 'south' | 'east' | 'west'): void {
    const body = document.getElementById('docking-policy-body');
    if (!body) return;
    const policy = readDoorPolicy(doorId);
    const owner = this.isRoomOwner();
    const myPub = getIdentityPub();
    const pill = `display:inline-block; padding:2px 8px; border-radius:6px; font-size:9px; font-weight:700; cursor:pointer; background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); color:#f0c060;`;
    const row = `display:flex; align-items:center; justify-content:space-between; gap:8px;`;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    // #67 D2: a live transient berth shows a DETACH row to EVERYONE — either
    // side may cast off a guest ship without owner ceremony.
    const st = this.doorState.get(doorId);
    const detachRow = st?.pairedSuccessfully && st.transient
      ? `<div style="${row}"><span style="color:#80d8ff;">⛴ TRANSIENT BERTH · ship docked</span>
           <button type="button" data-policy-action="detach-berth" style="${pill} background:rgba(255,23,68,0.10); border-color:rgba(255,23,68,0.35); color:#ff8a80;">⏏ DETACH</button></div>`
      : '';

    if (owner) {
      const requests = readDoorRequests(doorId);
      const grants = readDoorGrants(doorId);
      const reqRows = requests.map((r) => `
        <div style="${row}">
          <span style="color:#ffb300; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="key ${esc(r.requesterPub)}">⚠ ${esc(r.requesterName)} <span style="color:rgba(212,168,75,0.4);">${esc(r.requesterPub.slice(0, 8))}</span></span>
          <span style="flex-shrink:0; display:flex; gap:4px;">
            <button type="button" data-policy-action="accept-req" data-pub="${esc(r.requesterPub)}" data-name="${esc(r.requesterName)}" style="${pill} background:rgba(0,230,118,0.15); border-color:rgba(0,230,118,0.4); color:#00e676;">ACCEPT</button>
            <button type="button" data-policy-action="deny-req" data-pub="${esc(r.requesterPub)}" style="${pill} background:rgba(255,23,68,0.10); border-color:rgba(255,23,68,0.35); color:#ff8a80;">DENY</button>
          </span>
        </div>`).join('');
      const grantRows = grants.map((g) => `
        <div style="${row}">
          <span style="color:#00e676; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="key ${esc(g.pub)}">✔ ${esc(g.name)} <span style="color:rgba(212,168,75,0.4);">${esc(g.pub.slice(0, 8))}</span></span>
          <button type="button" data-policy-action="revoke-grant" data-pub="${esc(g.pub)}" style="${pill} background:rgba(255,23,68,0.10); border-color:rgba(255,23,68,0.35); color:#ff8a80;">REVOKE</button>
        </div>`).join('');
      body.innerHTML = `
        <div style="${row}"><span>PASSAGE <span style="color:rgba(212,168,75,0.4);">· open/close/walk${policy.oneWay ? ' · one-way for guests' : ''}</span></span>
          <button type="button" data-policy-action="cycle-passage" style="${pill}">${passageLabel(policy)}</button></div>
        <div style="${row}"><span>CONSTRUCTION <span style="color:rgba(212,168,75,0.4);">· dock/build</span></span>
          <button type="button" data-policy-action="cycle-construction" style="${pill}">${policy.construction.toUpperCase()}</button></div>
        <div style="${row}"><span>🧱 POSITION <span style="color:rgba(212,168,75,0.4);">· slide along wall${st?.pairedSuccessfully ? ' — unpair first' : ''}</span></span>
          <span style="flex-shrink:0; display:flex; gap:4px; align-items:center;">
            <button type="button" data-policy-action="slide-neg" ${st?.pairedSuccessfully ? 'disabled' : ''} style="${pill}">◀</button>
            <span style="font-size:9px; color:rgba(212,168,75,0.6); min-width:34px; text-align:center;">${(() => { const d = readDoorDeltas()[doorId] ?? 0; return d === 0 ? 'CENTER' : `${d > 0 ? '+' : ''}${d.toFixed(1)}m`; })()}</span>
            <button type="button" data-policy-action="slide-pos" ${st?.pairedSuccessfully ? 'disabled' : ''} style="${pill}">▶</button>
          </span></div>
        <div style="${row}"><span>🔌 DOCK ADAPTER <span style="color:rgba(212,168,75,0.4);">· guest berthing</span></span>
          ${policy.adapter
            ? `<button type="button" data-policy-action="remove-adapter" style="${pill} background:rgba(0,229,255,0.10); border-color:rgba(0,229,255,0.4); color:#80d8ff;">INSTALLED · ✕</button>`
            : `<button type="button" data-policy-action="install-adapter" style="${pill}" ${partsCount('adapter') === 0 ? 'disabled title="no ADAPTER parts — DEV menu › PARTS"' : ''}>INSTALL (×${partsCount('adapter')})</button>`}</div>
        ${detachRow}
        ${requests.length ? `<div style="font-size:9px; font-weight:800; color:rgba(255,179,0,0.7); letter-spacing:1px; margin-top:2px;">RIGHTS REQUESTS</div>${reqRows}` : ''}
        ${grants.length ? `<div style="font-size:9px; font-weight:800; color:rgba(0,230,118,0.6); letter-spacing:1px; margin-top:2px;">STANDING GRANTS</div>${grantRows}` : ''}
      `;
    } else {
      const granted = hasDoorGrant(doorId, myPub);
      const requested = hasDoorRequest(doorId, myPub);
      const buildLine = policy.construction === 'public'
        ? '<span style="color:#00e676;">BUILD: PUBLIC</span>'
        : policy.construction === 'request'
          ? (granted
            ? '<span style="color:#00e676;">✔ BUILD RIGHTS GRANTED</span>'
            : requested
              ? '<span style="color:#ffb300;">⏳ RIGHTS REQUESTED — awaiting the owner</span>'
              : `<button type="button" data-policy-action="req-build" style="${pill} background:rgba(255,179,0,0.12); border-color:rgba(255,179,0,0.4); color:#ffb300;">🙋 REQUEST BUILD RIGHTS</button>`)
          : '<span style="color:rgba(212,168,75,0.55);">BUILD: OWNER ONLY</span>';
      body.innerHTML = `
        <div style="${row}"><span>PASSAGE: ${passageLabel(policy)}</span>${buildLine}</div>
        ${policy.adapter && !this.canConstruct(doorId)
          ? `<div style="color:#80d8ff;">🔌 BERTHING OPEN — enter your ship's address above and INITIATE to dock transiently</div>`
          : ''}
        ${detachRow}
      `;
    }
  }

  /** #67: re-paint policy + assembly for the OPEN pane (doc-change refresh —
   *  a grant landing while a guest stares at the keypad unlocks it live). */
  public refreshPolicyUI(): void {
    const pane = document.getElementById('docking-control-pane');
    if (!pane || pane.style.display === 'none') return;
    const doorId = (pane as any).activeDoorId as ('north' | 'south' | 'east' | 'west') | null;
    if (!doorId) return;
    this.renderPolicySection(doorId);
    this.renderAssemblyStrip(doorId);
  }

  /** #62 P4: paint the assembly strip from the door's working chain. */
  private renderAssemblyStrip(doorId: 'north' | 'south' | 'east' | 'west', note?: string): void {
    const state = this.doorState.get(doorId);
    const chips = document.getElementById('docking-chips');
    const partsNote = document.getElementById('docking-parts-note');
    const farSel = document.getElementById('docking-far-door') as HTMLSelectElement | null;
    const yawBtn = document.getElementById('docking-far-yaw');
    if (!state || !chips) return;
    const segs = state.segments ?? [];
    // 🛰️ Hull-space honesty (the other direction of hull.ts's mount check):
    // warn when THIS chain's fold sweeps through mounted exterior equipment.
    const chainClash = (() => {
      if (segs.length === 0) return null;
      for (const cb of this.chainBoxesFor(doorId)) {
        for (const it of exteriorItemBoxes()) {
          if (cb.x0 < it.box.x1 && cb.x1 > it.box.x0 && cb.z0 < it.box.z1 && cb.z1 > it.box.z0) {
            return it.id;
          }
        }
      }
      return null;
    })();
    chips.innerHTML = segs.length === 0
      ? `<span style="font-size:9px; color:rgba(212,168,75,0.35);">no chain — a plain pairing uses the straight gangway</span>`
      : segs.map((s, i) => {
          const label = s.kind === 'flex'
            ? `FLEX ${(s.bendDeg ?? 0) > 0 ? '+' : ''}${s.bendDeg ?? 0}°`
            : `EXT ×${s.bays ?? 4}`;
          const skinBtn = s.kind === 'ext'
            ? `<button type="button" data-chip-action="skin" data-i="${i}" title="Toggle skin" style="background:none; border:none; color:rgba(212,168,75,0.7); font-size:8px; cursor:pointer; padding:0 2px;">${s.skin === 'solid' ? 'SOLID' : 'RIBBED'}</button>`
            : '';
          return `
            <span style="display:inline-flex; align-items:center; gap:4px; background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); border-radius:10px; padding:2px 8px; font-size:9px; font-weight:700;">
              <button type="button" data-chip-action="cycle" data-i="${i}" title="Click to cycle ${s.kind === 'flex' ? 'bend' : 'length'}" style="background:none; border:none; color:#f0c060; font-size:9px; font-weight:700; cursor:pointer; padding:0;">${label}</button>
              ${skinBtn}
              <button type="button" data-chip-action="remove" data-i="${i}" title="Remove (refunds the part)" style="background:none; border:none; color:#ff8a80; font-size:9px; cursor:pointer; padding:0 1px;">✕</button>
            </span>`;
        }).join('') + (chainClash
          ? `<div style="font-size:9px; color:#FFB300; margin-top:4px;">⚠ chain sweeps through mounted equipment (${chainClash}) — bend around it or move the mount</div>`
          : '');
    if (partsNote) {
      partsNote.textContent = note
        ?? (this.canConstruct(doorId)
          ? `· stock F×${partsCount('flex')} E×${partsCount('ext')}`
          : readDoorPolicy(doorId).construction === 'request'
            ? '· no build rights — REQUEST below'
            : '· owner only on this port');
    }
    if (farSel) farSel.value = state.farDoor ?? '';
    if (yawBtn) yawBtn.textContent = `YAW ${state.farYawDeg === undefined ? '—' : state.farYawDeg}`;
    // 🧲 Every chain edit re-tests whether the far end now reaches a known
    // module — the connect prompt appears/disappears as you build.
    this.detectChainContact(doorId);
  }

  /** #62 P4: a post-pairing chain edit re-fires the ACCEPTED publish so the
   *  record rewrites and every client's geometry diff picks it up. */
  private publishIfPaired(doorId: 'north' | 'south' | 'east' | 'west'): void {
    const state = this.doorState.get(doorId);
    if (state?.pairedSuccessfully && this.onPairingStatusChangedCallback) {
      this.onPairingStatusChangedCallback(doorId, 'ACCEPTED');
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

    // #62 P4: armed-preset prefill — an unpaired door with no working chain
    // opens with the DEV-armed preset's chips already placed (parts consumed
    // atomically; silently skipped when stock is short). RING targets a
    // diamond ring room, so it defaults FAR yaw to 45. OWNER-only (vestibule
    // findings): a guest merely inspecting a keypad must not consume parts or
    // arm a ghost on someone else's room.
    if (this.canConstruct(doorId) && !state.pairedSuccessfully && (!state.segments || state.segments.length === 0)) {
      const preset = armedPreset();
      if (preset) {
        const segs = presetSegments(preset);
        if (consumeForSegments(segs)) {
          state.segments = segs;
          if (preset === 'ring' && state.farYawDeg === undefined) state.farYawDeg = 45;
          this.untouchedPrefills.add(doorId); // refunded on close unless used
        }
      }
    }
    this.renderAssemblyStrip(doorId);
    this.renderPolicySection(doorId); // #67 D1
    this.renderKnownModules();        // 🗺️ atlas picker
  }

  /**
   * 🧲 Chain-contact detection (owner's ask): fold the WORKING chain from
   * this door and test whether the module that would sit at its far end
   * coincides with a KNOWN module (the station atlas, laid out through the
   * connection graph — so closing the octagon matches room 1 via the path
   * around the ring). On contact: prompt right in the pane — CONNECT fills
   * the address + FAR door and fires the normal INITIATE path.
   * Works for modules the atlas can PLACE (reachable through known links);
   * an island module it has never seen connected can't be matched.
   */
  private detectChainContact(doorId: 'north' | 'south' | 'east' | 'west'): void {
    const slot = document.getElementById('docking-dock-detect');
    if (!slot) return;
    slot.style.display = 'none';
    const state = this.doorState.get(doorId);
    if (!state || state.pairedSuccessfully || !state.segments || state.segments.length === 0) return;
    const currentId = (window as unknown as { __ssfRoomId?: string }).__ssfRoomId ?? '';
    if (!currentId) return;

    // Where would a module sit at this chain's far end? (Room-local = world
    // for the current room — the same frame atlasLayout emits.)
    const wouldBe = projectionPoseForDoor(doorId, state.segments, undefined);
    const layout = atlasLayout(currentId, (d, s, f) => projectionPoseForDoor(d, s, f), 8);
    let best: { roomId: string; name: string; seed?: string; dist: number; door: string } | null = null;
    const DOOR_YAW: Record<string, number> = { south: 0, east: Math.PI / 2, north: Math.PI, west: -Math.PI / 2 };
    const angDiff = (a: number, b: number) => {
      let d = (a - b) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return Math.abs(d);
    };
    for (const mod of layout) {
      const dist = Math.hypot(mod.x - wouldBe.x, mod.z - wouldBe.z);
      if (dist > 4.5 || (best && dist >= best.dist)) continue;
      // The chain arrives heading wouldBe.rotY (no farDoor ⇒ rotY = heading);
      // the matching door of the module faces BACK along it.
      const arrivalFacing = wouldBe.rotY + Math.PI;
      let doorPick: string | null = null;
      let doorErr = Math.PI;
      for (const d of ['north', 'south', 'east', 'west']) {
        const err = angDiff(mod.rotY + DOOR_YAW[d], arrivalFacing);
        if (err < doorErr) { doorErr = err; doorPick = d; }
      }
      if (doorPick && doorErr < Math.PI / 3) {
        best = { roomId: mod.roomId, name: mod.name, seed: mod.seed, dist, door: doorPick };
      }
    }
    if (!best || !best.seed) return;

    // 🛬 JETBRIDGE FIT: solve the chain's free parameters (continuous bends,
    // flex + telescoping ext stretch) so the fold lands EXACTLY on the
    // matched module's door face — the owner's ruling: the chain adjusts to
    // reality (a 45° preset relaxes to 40°, bends equalize, the extension
    // slides). Target = the matched door's face, in this door's chain frame.
    const mod = layout.find((m) => m.roomId === best!.roomId)!;
    const dyaw: Record<string, number> = { south: 0, east: Math.PI / 2, north: Math.PI, west: -Math.PI / 2 };
    // 🧱 #66: doorFaceLocal is the MATCHED NEIGHBOUR's door face in ITS frame —
    // its size isn't known locally, so ±6 (default 2×2) holds until R4 carries
    // per-neighbour farExtents. ourFace below IS our room ⇒ derives from ours.
    const doorFaceLocal = { north: { x: 0, z: -6 }, south: { x: 0, z: 6 }, east: { x: 6, z: 0 }, west: { x: -6, z: 0 } }[best.door]!;
    const mc = Math.cos(mod.rotY), ms = Math.sin(mod.rotY);
    const faceWorld = {
      x: mod.x + doorFaceLocal.x * mc + doorFaceLocal.z * ms,
      z: mod.z - doorFaceLocal.x * ms + doorFaceLocal.z * mc,
    };
    // Chain frame: origin at OUR door face, +z outward, rotated by our door's
    // yaw — both from the active layout (neighbour's doorFaceLocal stays ±6, R4).
    const ourPose = physicalDoorPose(doorId);
    const ourYaw = ourPose.outwardYaw;
    const ourFace = { x: ourPose.x, z: ourPose.z };
    const dx = faceWorld.x - ourFace.x, dz = faceWorld.z - ourFace.z;
    const oc = Math.cos(-ourYaw), os = Math.sin(-ourYaw);
    const targetLocal = {
      x: dx * oc + dz * os,
      z: -dx * os + dz * oc,
      // Chain exit heading must point INTO the matched door.
      yawRad: (mod.rotY + dyaw[best.door] + Math.PI) - ourYaw,
    };
    // Normalize the yaw into (-π, π].
    while (targetLocal.yawRad > Math.PI) targetLocal.yawRad -= Math.PI * 2;
    while (targetLocal.yawRad <= -Math.PI) targetLocal.yawRad += Math.PI * 2;
    const solved = solveChain(state.segments, targetLocal);
    const fits = solved.residualDist < 0.35 && solved.residualYawDeg < 4;

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const fitNote = fits
      ? (() => {
        const bends = solved.segments.filter((s) => s.kind === 'flex').map((s) => `${(s.bendDeg ?? 0).toFixed(1)}°`).join('/');
        return ` · auto-fit ${bends}`;
      })()
      : ' · rigid (fit out of range)';
    slot.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; border:1px solid rgba(0,230,118,0.35); border-radius:6px; padding:6px 10px; background:rgba(0,230,118,0.06);">
        <span style="flex:1; font-size:9.5px; color:#00e676;">🧲 CHAIN REACHES <b>${esc(best.name)}</b> — connect via its ${best.door.toUpperCase()} door?<span style="color:rgba(0,230,118,0.6);">${fitNote}</span></span>
        <button type="button" id="docking-dock-connect" style="background:rgba(0,230,118,0.15); border:1px solid rgba(0,230,118,0.4); border-radius:5px; color:#00e676; font-size:9px; font-weight:800; padding:3px 10px; cursor:pointer;">CONNECT</button>
      </div>`;
    slot.style.display = 'block';
    document.getElementById('docking-dock-connect')?.addEventListener('click', () => {
      const st = this.doorState.get(doorId);
      // 🛬 Apply the SOLVED chain (exact fit) before pairing — the record
      // then carries the fitted geometry to every client.
      if (st && fits) {
        st.segments = solved.segments;
        this.renderAssemblyStrip(doorId);
      }
      const addr = document.getElementById('docking-addr-input') as HTMLInputElement | null;
      const far = document.getElementById('docking-far-door') as HTMLSelectElement | null;
      if (addr) addr.value = best!.seed!;
      if (far) far.value = best!.door;
      if (st) st.farDoor = best!.door as 'north' | 'south' | 'east' | 'west';
      // Fire the normal INITIATE path (all its gates apply).
      document.getElementById('docking-request-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  /** 🗺️ Repopulate the known-modules picker from the station atlas (every
   *  entry holding an address, current room excluded, most recent first). */
  private renderKnownModules(): void {
    const sel = document.getElementById('docking-known-modules') as HTMLSelectElement | null;
    if (!sel) return;
    const currentId = (window as unknown as { __ssfRoomId?: string }).__ssfRoomId ?? '';
    const entries = Object.values(readAtlas())
      .filter((e) => e.seed && e.roomId !== currentId)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 24);
    sel.innerHTML = '<option value="">🗺️ … or pick a KNOWN MODULE</option>'
      + entries.map((e) => {
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        return `<option value="${esc(e.seed!)}">${esc(e.name)} · ${esc(e.roomId.slice(0, 10))}</option>`;
      }).join('');
    sel.style.display = entries.length > 0 ? 'block' : 'none';
  }

  /** Refund + drop an untouched prefill chain (see untouchedPrefills docs). */
  private discardUntouchedPrefill(doorId: 'north' | 'south' | 'east' | 'west'): void {
    if (!this.untouchedPrefills.delete(doorId)) return;
    const state = this.doorState.get(doorId);
    if (!state || state.pairedSuccessfully || !state.segments?.length) return;
    refundForSegments(state.segments);
    state.segments = undefined;
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
      // Vestibule-findings fix (ghost residue): a REJECTED connection's working
      // chain must not linger as a ghost tube on an unpaired door — refund the
      // parts and drop it.
      if (state.segments?.length) refundForSegments(state.segments);
      state.segments = undefined;
      this.syncLEDStatus(doorId, state);
    }

    if (this.onPairingStatusChangedCallback) {
      this.onPairingStatusChangedCallback(doorId, accept ? 'ACCEPTED' : 'REJECTED');
    }
  }

  /**
   * #64: apply a pairing ANOTHER user in the room made, delivered via the shared
   * `doors` doc. Mirrors completePairing's accept branch (open door, draw the
   * adjacent-module projection, mark paired so transitReady passes) but does NOT
   * fire onPairingStatusChanged — that callback publishes to the doc, and a remote
   * apply must never re-publish (it would loop). Idempotent: re-applying the same
   * pairing is a no-op (drawAdjacentRoomProjection guards on adjacentRooms.has).
   */
  public applyRemotePairing(
    doorId: DoorId,
    address: string,
    geometry?: { segments?: ConnectorSegment[]; farDoor?: DoorId; farYawDeg?: 0 | 45; transient?: boolean },
  ): void {
    const state = this.doorState.get(doorId);
    if (!state) return;
    // #62 P2: idempotency must diff the GEOMETRY too — a post-pairing chain
    // edit rewrites the record with the same address, and every client must
    // pick it up (P3 rebuilds the chain + reposes the projection on change).
    const sameGeometry =
      JSON.stringify(state.segments ?? null) === JSON.stringify(geometry?.segments ?? null) &&
      state.farDoor === geometry?.farDoor &&
      state.farYawDeg === geometry?.farYawDeg;
    if (state.pairedSuccessfully && state.connectedRoomAddress === address && sameGeometry) return;
    state.connectedRoomAddress = address;
    state.segments = geometry?.segments;
    state.farDoor = geometry?.farDoor;
    state.farYawDeg = geometry?.farYawDeg;
    state.transient = geometry?.transient === true; // #67 D2
    state.pairingPending = false;
    state.pairedSuccessfully = true;
    state.locked = false;
    this.syncLEDStatus(doorId, state);
    this.drawAdjacentRoomProjection(doorId);
    this.openDoor(doorId);
  }

  /**
   * #64: reverse a pairing removed from the shared `doors` doc (unpair) — tear the
   * projection down, close + re-lock the door. No-op on an already-unpaired door,
   * and (like applyRemotePairing) never fires the publish callback.
   */
  public clearRemotePairing(doorId: DoorId): void {
    const state = this.doorState.get(doorId);
    if (!state || !state.pairedSuccessfully) return;
    state.pairedSuccessfully = false;
    state.pairingPending = false;
    state.connectedRoomAddress = '';
    state.segments = undefined;
    state.farDoor = undefined;
    state.farYawDeg = undefined;
    state.transient = false;
    state.locked = true;
    this.removeAdjacentRoomProjection(doorId);
    this.closeDoor(doorId);
    this.syncLEDStatus(doorId, state);
  }

  /** Remove + dispose the adjacent-module gray-box projection (inverse of
   *  drawAdjacentRoomProjection). */
  private removeAdjacentRoomProjection(doorId: DoorId): void {
    const adj = this.adjacentRooms.get(doorId);
    if (!adj) return;
    this.roomsGroup.remove(adj);
    adj.geometry.dispose();
    if (adj.material instanceof THREE.Material) adj.material.dispose();
    this.adjacentRooms.delete(doorId);
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

  /**
   * Set the room's ENTRY access mode (public-doors feature) and tint every
   * door's status LED so a visitor reads the room's openness at any threshold:
   * green = PUBLIC (anyone enters), amber = PASS (anyone with the link —
   * today's default), red = KEYED (granted keys only; enforced once keyed
   * identity ships). Driven from the roomInfo observer; distinct from the
   * per-door pairing/lock the docking terminal manages. Idempotent.
   */
  public setAccessMode(mode: 'public' | 'pass' | 'keyed'): void {
    this.accessMode = mode;
    const color = mode === 'public' ? 0x00e676 : mode === 'keyed' ? 0xff1744 : 0xd4a84b;
    for (const group of this.doorObjects.values()) {
      const led = group.getObjectByName('ledStatus') as THREE.Mesh | null;
      const mat = led?.material as THREE.MeshBasicMaterial | undefined;
      if (mat?.color) mat.color.setHex(color);
    }
  }

  /** The current room entry access mode (public-doors feature). */
  public getAccessMode(): 'public' | 'pass' | 'keyed' {
    return this.accessMode;
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

  /**
   * #51 — screen-lower door transparency in the isometric view. Doors on the
   * camera-facing walls occlude the room interior, so their leaves + frames
   * ease to FACING_FADE_OPACITY while:
   *   - `enabled` (ortho room view live: zoom 2–4, no morph, no device focus),
   *   - the wall's outward normal points toward the camera azimuth (the rig's
   *     current 45° detent — rotation changes WHICH doors are screen-lower),
   *   - and the door is not `activeDoorId` (a walk-through/transit in
   *     progress restores full opacity for the crossing).
   * Called once per frame from World.update, right after update().
   */
  public updateFacingFade(deltaTime: number, enabled: boolean, activeDoorId: DoorId | null): void {
    // Camera XZ direction for the current detent: the base isometric offset
    // sits on the +X/+Z diagonal (renderer/zoom convention), swung by the
    // rig's snapped yaw — x' = (cosθ+sinθ)/√2, z' = (cosθ−sinθ)/√2.
    const yaw = getCameraYaw();
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const camX = (c + s) * Math.SQRT1_2;
    const camZ = (c - s) * Math.SQRT1_2;

    for (const [doorId, mats] of this.doorFadeMats) {
      const n = DoorDockingPortSystem.DOOR_NORMALS[doorId];
      // 45° detents yield dots of 0 / ±0.707 / ±1 — 0.3 splits camera-facing
      // walls (0.707, 1) from side-on and far walls (0, negatives).
      const facing = n.x * camX + n.z * camZ > 0.3;
      const target = enabled && facing && activeDoorId !== doorId
        ? DoorDockingPortSystem.FACING_FADE_OPACITY
        : 1.0;

      const current = this.doorFadeOpacity.get(doorId) ?? 1;
      if (current === target) continue;
      let next = current + (target - current) * Math.min(1, 8 * deltaTime);
      if (Math.abs(next - target) < 0.01) next = target;
      this.doorFadeOpacity.set(doorId, next);
      const transparent = next < 0.999;
      for (const mat of mats) {
        mat.opacity = next;
        mat.transparent = transparent;
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
    // #62 P3: the projection is POSED FROM THE CONNECTION RECORD — the far
    // room's box sits at the folded chain's exit (at its angle) instead of the
    // old hardcoded cardinal 15.2. Legacy pairings (no segments) get the exact
    // pre-#62 pose from the same pure function. Rebuild-on-diff: a chain edit
    // re-runs this via applyRemotePairing's geometry diff, so an existing box
    // drawn with the SAME geometry stays; a different one is disposed+redrawn.
    const state = this.doorState.get(doorId);
    const poseKey = JSON.stringify({ s: state?.segments ?? null, f: state?.farDoor ?? null });
    const existing = this.adjacentRooms.get(doorId);
    if (existing) {
      if (existing.userData.poseKey === poseKey) return; // unchanged — keep it
      this.removeAdjacentRoomProjection(doorId);
    }

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
    const pose = projectionPoseForDoor(doorId, state?.segments, state?.farDoor);
    adjRoom.position.set(pose.x, 2, pose.z);
    adjRoom.rotation.y = pose.rotY;
    adjRoom.userData.poseKey = poseKey;

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

  /** #67 D1: passage check for walk-through/transit (world.ts consults this
   *  before offering the door sequence). */
  public canPass(doorId: string): boolean {
    // 🚪↦ ONE-WAY doors (owner request): this is the DEPARTURE/local-crossing
    // gate (walkthroughs + FP auto-doors) — an IN-only door refuses guest
    // departures (travelers may only come IN through it). OUT-only arrivals
    // are the turnstile's job (world.completeAdapterArrival). Owners pass
    // both ways, always.
    if (this.isRoomOwner()) return true;
    const p = readDoorPolicy(doorId);
    return p.passage === 'public' && p.oneWay !== 'in';
  }

  /** 🧱 #66 S1: slide each door's 3D group (frame + leaves + keypad ride the
   *  same group) along its wall by the placement delta. Legacy group lateral
   *  is 0 for every door, so position = delta directly. */
  /**
   * 👻🏊 Outdoor open-air mode: ghost every door group down to a faint
   * translucent silhouette (like the entrance glass) so the pool deck reads
   * unobstructed — doors stay raycastable/clickable for transit. Restores the
   * stored opacities when off. Writes userData.baseOpacity so the morph/zoom
   * fade machinery converges to the ghost value instead of fighting it.
   */
  public setGhostDoors(on: boolean): void {
    for (const [, group] of this.doorObjects) {
      group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) {
          const m = mat as THREE.Material & { opacity: number; transparent: boolean };
          if (on) {
            if (m.userData.ghostPrev === undefined) {
              m.userData.ghostPrev = {
                opacity: m.opacity,
                baseOpacity: m.userData.baseOpacity as number | undefined,
                transparent: m.transparent,
              };
            }
            const prev = m.userData.ghostPrev as { opacity: number; baseOpacity?: number };
            const target = Math.min(0.16, prev.baseOpacity ?? 1);
            m.transparent = true;
            m.userData.baseOpacity = target;
            m.opacity = Math.min(m.opacity, target);
          } else if (m.userData.ghostPrev !== undefined) {
            const prev = m.userData.ghostPrev as { opacity: number; baseOpacity?: number; transparent: boolean };
            delete m.userData.ghostPrev;
            m.transparent = prev.transparent;
            if (prev.baseOpacity === undefined) delete m.userData.baseOpacity;
            else m.userData.baseOpacity = prev.baseOpacity;
            m.opacity = prev.opacity;
          }
        }
      });
    }
  }

  public repositionDoorGroups(deltas: Record<'north' | 'south' | 'east' | 'west', number>): void {
    for (const [id, group] of this.doorObjects) {
      const doorId = id as 'north' | 'south' | 'east' | 'west';
      const pose = physicalDoorPose(doorId, deltas[doorId] ?? 0);
      group.position.set(pose.x, 2, pose.z);
      group.rotation.y = pose.frameYaw;
    }
  }

  /** 🛰️ Exterior view: edit one chain segment in place (the click-a-joint
   *  BEND editor). Same rights gate + publish path as the keypad chips — the
   *  record rewrites and every client's geometry diff rebuilds the chain.
   *  Returns false when refused (no rights / no such segment). */
  public editChainSegment(
    doorId: 'north' | 'south' | 'east' | 'west',
    index: number,
    patch: { bendDeg?: number; stretch?: number; bays?: number; skin?: 'ribbed' | 'solid' },
  ): boolean {
    const state = this.doorState.get(doorId);
    if (!state || !state.segments || !state.segments[index]) return false;
    if (!this.canConstruct(doorId)) return false;
    const seg = { ...state.segments[index], ...patch };
    state.segments = state.segments.map((s, i) => (i === index ? seg : s));
    this.untouchedPrefills.delete(doorId);
    this.renderAssemblyStrip(doorId); // keep an open keypad in sync
    this.publishIfPaired(doorId);
    return true;
  }

  /** #62 P4: wire the auto-accept decider (see field docs). */
  public onAutoAcceptCheck(cb: (address: string) => boolean) {
    this.autoAcceptCheckCallback = cb;
  }

  /** Owner gate: wire the "is the local player this room's owner?" decider. */
  public onOwnerCheck(cb: () => boolean) {
    this.ownerCheckCallback = cb;
  }

  /** Wire the PROVISION NEW MODULE minting callback (see field docs). */
  public onProvisionModule(cb: () => Promise<string | null>) {
    this.provisionModuleCallback = cb;
  }
}
