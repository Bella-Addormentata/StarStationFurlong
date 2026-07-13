/**
 * Device props (PR-P of issues #33 + #35)
 *
 * Two purely cosmetic, self-contained prop builders (imports THREE only —
 * same pattern as adapter.ts from PR #34):
 *
 *  - buildStorageTrunk()  — TR1 of #35: concept-art-faithful ISS storage
 *    trunk with an update-loop-driven hinged lid animation.
 *  - buildWallComputer()  — the prop half of M1 of #33: wall-mounted room
 *    terminal whose screen is a live CanvasTexture redrawn on demand
 *    (the dev hook calls updateStatus ~1 Hz).
 *
 * No gameplay, no network, no focus/interaction wiring in this slice —
 * those arrive with D0 (see brainstorming/device-focus-and-storage-trunk-plan.md).
 * Previewed behind the `?deviceprops=1` dev flag in main.ts init().
 */

import * as THREE from 'three';

// ── Shared palette ───────────────────────────────────────────────────────────
const COL_TRUNK_BODY = 0xB8BEC6;   // light-gray ribbed shell
const COL_TRUNK_RIB = 0xA6ADB6;    // slightly darker ribs / panel lines
const COL_TRUNK_ORANGE = 0xE8760A; // corner reinforcements, latch plates, lid trim
const COL_TRUNK_LATCH = 0x6E7680;  // gray latch hardware
const COL_TRUNK_DARK = 0x14181E;   // interior cavity / label plate
const COL_TRUNK_TRAY = 0x2A3038;   // tool-tray layer
const COL_HOUSING = 0x2A3444;      // wall-computer dark slate (gunmetal, matches adapter)
const COL_BEZEL = 0x3D4A5E;        // lighter bezel around the screen
const COL_ACCENT = 0xD4A84B;       // amber accent strip (keypad-gold, see docking.ts)

const mat = (color: number, roughness = 0.7, metalness = 0.3) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

const addBox = (
  parent: THREE.Object3D, m: THREE.Material,
  w: number, h: number, d: number,
  x: number, y: number, z: number,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
};

/** One-shot pixel-text decal (star-window CanvasTexture idiom, world.ts). */
function makeStencilTexture(text: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 48;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#14181E';
  ctx.fillRect(0, 0, 128, 48);
  ctx.strokeStyle = '#3A424C';
  ctx.strokeRect(2.5, 2.5, 123, 43);
  ctx.fillStyle = '#E8ECF2';
  ctx.font = 'bold 18px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 25);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

// ═════════════════════════════════════════════════════════════════════════════
// Storage trunk (TR1 of #35)
// ═════════════════════════════════════════════════════════════════════════════

export interface StorageTrunkProp {
  group: THREE.Group;
  /** Swing the lid open backward (~100°). onComplete fires exactly once on arrival. */
  openLid(onComplete?: () => void): void;
  /** Swing the lid closed. onComplete fires exactly once on arrival. */
  closeLid(onComplete?: () => void): void;
  /** Drive from the host update loop (NOT a detached rAF loop — see PR #29's doors). */
  update(deltaTime: number): void;
}

// Overall footprint ~1.0w × 0.65h × 0.6d, front face toward local +z.
const TRUNK_W = 1.0;
const TRUNK_D = 0.6;
const BODY_H = 0.5;    // shell height; lid adds 0.15 → 0.65 total
const LID_H = 0.15;
const WALL_T = 0.05;
const LID_OPEN_ANGLE = -Math.PI * (100 / 180); // negative rotation.x = swing up + backward
const LID_SPEED = 2.4; // rad/s, constant-speed ease

export function buildStorageTrunk(): StorageTrunkProp {
  const group = new THREE.Group();
  group.name = 'storageTrunk';
  group.userData = { isStorageTrunk: true };

  const bodyMat = mat(COL_TRUNK_BODY, 0.65, 0.35);
  const ribMat = mat(COL_TRUNK_RIB, 0.7, 0.3);
  const orangeMat = mat(COL_TRUNK_ORANGE, 0.5, 0.4);
  const latchMat = mat(COL_TRUNK_LATCH, 0.45, 0.6);
  const darkMat = mat(COL_TRUNK_DARK, 0.9, 0.1);
  const trayMat = mat(COL_TRUNK_TRAY, 0.8, 0.2);

  // ── Body shell: floor + four walls, leaving a real cavity for the open lid
  addBox(group, bodyMat, TRUNK_W, WALL_T, TRUNK_D, 0, WALL_T / 2, 0);                                  // floor
  addBox(group, bodyMat, TRUNK_W, BODY_H - WALL_T, WALL_T, 0, (BODY_H + WALL_T) / 2, (TRUNK_D - WALL_T) / 2);   // front
  addBox(group, bodyMat, TRUNK_W, BODY_H - WALL_T, WALL_T, 0, (BODY_H + WALL_T) / 2, -(TRUNK_D - WALL_T) / 2);  // back
  addBox(group, bodyMat, WALL_T, BODY_H - WALL_T, TRUNK_D - 2 * WALL_T, -(TRUNK_W - WALL_T) / 2, (BODY_H + WALL_T) / 2, 0); // left
  addBox(group, bodyMat, WALL_T, BODY_H - WALL_T, TRUNK_D - 2 * WALL_T, (TRUNK_W - WALL_T) / 2, (BODY_H + WALL_T) / 2, 0);  // right

  // ── Interior: dark cavity liner + a hint of a tool-tray layer
  addBox(group, darkMat, TRUNK_W - 2 * WALL_T, 0.02, TRUNK_D - 2 * WALL_T, 0, WALL_T + 0.01, 0);       // dark bottom
  const tray = addBox(group, trayMat, TRUNK_W - 2 * WALL_T - 0.06, 0.03, TRUNK_D - 2 * WALL_T - 0.06, 0, 0.30, 0);
  tray.name = 'toolTray';
  // A few colored blocks suggesting stowed tools on the tray
  const toolBlocks: Array<[number, number, number, number]> = [
    [0xE8760A, -0.28, 0.16, 0.05], // orange driver
    [0x00E5FF, -0.06, 0.10, 0.05], // cyan gauge
    [0xD4A84B, 0.14, 0.20, 0.05],  // amber wrench case
    [0x8899AA, 0.32, 0.08, 0.05],  // gray spares tin
  ];
  toolBlocks.forEach(([color, x, w, h]) => {
    addBox(group, mat(color, 0.6, 0.3), w, h, 0.14, x, 0.315 + h / 2, 0.02);
  });

  // ── Ribs (vertical, front + back faces) and side panel lines
  for (const rx of [-0.32, -0.11, 0.11, 0.32]) {
    addBox(group, ribMat, 0.055, BODY_H - 0.14, 0.015, rx, BODY_H / 2, TRUNK_D / 2 + 0.005);   // front ribs
    addBox(group, ribMat, 0.055, BODY_H - 0.14, 0.015, rx, BODY_H / 2, -TRUNK_D / 2 - 0.005);  // back ribs
  }
  for (const sx of [-1, 1]) {
    addBox(group, ribMat, 0.015, BODY_H - 0.14, 0.055, sx * (TRUNK_W / 2 + 0.005), BODY_H / 2, -0.12); // side rib
    addBox(group, ribMat, 0.015, BODY_H - 0.14, 0.055, sx * (TRUNK_W / 2 + 0.005), BODY_H / 2, 0.12);  // side rib
  }
  // Horizontal panel line across the front, above the label band
  addBox(group, ribMat, TRUNK_W - 0.08, 0.02, 0.012, 0, 0.40, TRUNK_D / 2 + 0.004);

  // ── Orange corner reinforcements (all four vertical corners)
  for (const cx of [-1, 1]) {
    for (const cz of [-1, 1]) {
      addBox(group, orangeMat, 0.09, BODY_H, 0.02, cx * (TRUNK_W / 2 - 0.045), BODY_H / 2, cz * (TRUNK_D / 2 + 0.006));
      addBox(group, orangeMat, 0.02, BODY_H, 0.09, cx * (TRUNK_W / 2 + 0.006), BODY_H / 2, cz * (TRUNK_D / 2 - 0.045));
    }
  }

  // ── Front hardware: orange latch plates + gray latches, dark label plate
  for (const lx of [-0.30, 0.30]) {
    addBox(group, orangeMat, 0.12, 0.16, 0.02, lx, BODY_H - 0.06, TRUNK_D / 2 + 0.008);   // latch plate
    addBox(group, latchMat, 0.07, 0.10, 0.03, lx, BODY_H - 0.07, TRUNK_D / 2 + 0.022);    // latch body
  }
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34, 0.13),
    new THREE.MeshBasicMaterial({ map: makeStencilTexture('ISS-ST04') }),
  );
  label.position.set(0, 0.24, TRUNK_D / 2 + 0.012);
  group.add(label);

  // ── Lid: its own sub-Group hinged at the BACK top edge. Children sit
  //    forward of the hinge (+z), so negative rotation.x swings the lid
  //    up and backward over the back wall.
  const lid = new THREE.Group();
  lid.name = 'trunkLid';
  lid.position.set(0, BODY_H, -TRUNK_D / 2);
  group.add(lid);

  addBox(lid, bodyMat, TRUNK_W, LID_H, TRUNK_D, 0, LID_H / 2, TRUNK_D / 2);                       // lid slab
  addBox(lid, darkMat, TRUNK_W - 2 * WALL_T, 0.015, TRUNK_D - 2 * WALL_T, 0, 0.002, TRUNK_D / 2); // dark underside
  // Orange lid trim: front edge strip + side edge strips
  addBox(lid, orangeMat, TRUNK_W, 0.04, 0.02, 0, 0.04, TRUNK_D + 0.006);
  for (const sx of [-1, 1]) {
    addBox(lid, orangeMat, 0.02, 0.04, TRUNK_D, sx * (TRUNK_W / 2 + 0.006), 0.04, TRUNK_D / 2);
  }
  // Subtle top handle recess: dark inset with a gray grab bar
  addBox(lid, darkMat, 0.30, 0.02, 0.12, 0, LID_H - 0.005, TRUNK_D / 2);
  addBox(lid, latchMat, 0.22, 0.025, 0.03, 0, LID_H + 0.002, TRUNK_D / 2);

  // ── Lid animation state: constant-speed ease driven by update(dt)
  let lidAngle = 0;
  let lidTarget = 0;
  let pendingComplete: (() => void) | null = null;

  const setLidTarget = (target: number, onComplete?: () => void) => {
    if (target === lidTarget && lidAngle !== target) {
      // Same-target re-request while mid-swing: the earlier motion DOES still
      // arrive, so chain both callbacks instead of dropping the first.
      const prev = pendingComplete;
      pendingComplete = onComplete ? (prev ? () => { prev(); onComplete(); } : onComplete) : prev;
      return;
    }
    // A direction-changing call drops the previous callback (its motion never arrives).
    pendingComplete = null;
    lidTarget = target;
    if (lidAngle === lidTarget) { onComplete?.(); return; } // already there → fire once, now
    pendingComplete = onComplete ?? null;
  };

  return {
    group,
    openLid: (onComplete?: () => void) => setLidTarget(LID_OPEN_ANGLE, onComplete),
    closeLid: (onComplete?: () => void) => setLidTarget(0, onComplete),
    update(deltaTime: number): void {
      if (lidAngle === lidTarget) return;
      const diff = lidTarget - lidAngle;
      const step = LID_SPEED * Math.max(0, deltaTime);
      if (Math.abs(diff) <= step) {
        lidAngle = lidTarget;
        lid.rotation.x = lidAngle;
        if (pendingComplete) {
          const cb = pendingComplete;
          pendingComplete = null; // exactly once
          cb();
        }
      } else {
        lidAngle += Math.sign(diff) * step;
        lid.rotation.x = lidAngle;
      }
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Wall computer (prop half of M1 of #33)
// ═════════════════════════════════════════════════════════════════════════════

export interface WallComputerStatus {
  roomName: string;
  peers: number;
  nodeOnline: boolean;
}

export interface WallComputerProp {
  group: THREE.Group;
  /** Redraw the screen. Only called ~1 Hz by the host — no internal timer. */
  updateStatus(status: WallComputerStatus): void;
}

// Overall ~0.9w × 0.7h × 0.12d, centered on the group origin,
// screen facing local +z (rotate the group to face the room).
const WC_W = 0.9;
const WC_H = 0.7;
const WC_D = 0.12;

export function buildWallComputer(): WallComputerProp {
  const group = new THREE.Group();
  group.name = 'wallComputer';
  group.userData = { isWallComputer: true };

  const housingMat = mat(COL_HOUSING, 0.6, 0.5);
  const bezelMat = mat(COL_BEZEL, 0.55, 0.45);
  const accentMat = mat(COL_ACCENT, 0.4, 0.5);

  addBox(group, housingMat, WC_W, WC_H, WC_D - 0.04, 0, 0, -0.02);              // housing (back)
  addBox(group, bezelMat, 0.82, 0.60, 0.03, 0, 0.02, WC_D / 2 - 0.015);         // bezel
  addBox(group, accentMat, WC_W, 0.05, 0.03, 0, -WC_H / 2 + 0.025, WC_D / 2 - 0.015); // amber strip, bottom
  addBox(group, housingMat, 0.20, 0.06, 0.02, 0, -WC_H / 2 + 0.025, WC_D / 2 + 0.001); // strip badge

  // ── Screen: live CanvasTexture, redrawn only by updateStatus()
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 192;
  const ctx = cv.getContext('2d')!;
  const screenTex = new THREE.CanvasTexture(cv);
  screenTex.minFilter = THREE.NearestFilter;
  screenTex.magFilter = THREE.NearestFilter;
  screenTex.generateMipmaps = false;
  screenTex.colorSpace = THREE.SRGBColorSpace;

  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.72, 0.50),
    new THREE.MeshBasicMaterial({ map: screenTex }), // unlit = emissive screen read
  );
  screen.name = 'wallComputerScreen';
  screen.position.set(0, 0.02, WC_D / 2 + 0.002);
  group.add(screen);

  const drawStatus = (status: WallComputerStatus) => {
    ctx.imageSmoothingEnabled = false;
    // Background + frame
    ctx.fillStyle = '#0A1018';
    ctx.fillRect(0, 0, 256, 192);
    ctx.strokeStyle = '#1E2A38';
    ctx.strokeRect(3.5, 3.5, 249, 185);
    // Header: room name (amber)
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#D4A84B';
    ctx.fillText(status.roomName.toUpperCase().slice(0, 16), 14, 28);
    ctx.strokeStyle = '#D4A84B';
    ctx.beginPath(); ctx.moveTo(14, 38); ctx.lineTo(242, 38); ctx.stroke();
    // Peer count (cyan)
    ctx.font = '14px monospace';
    ctx.fillStyle = '#00E5FF';
    ctx.fillText(`PEERS: ${status.peers}`, 14, 62);
    // Node status LED + label
    ctx.beginPath();
    ctx.arc(21, 82, 5, 0, Math.PI * 2);
    ctx.fillStyle = status.nodeOnline ? '#00E676' : '#FF1744';
    ctx.fill();
    ctx.fillStyle = '#8FA3B8';
    ctx.fillText(`NODE ${status.nodeOnline ? 'ONLINE' : 'OFFLINE'}`, 34, 87);
    // Wireframe room-outline motif (full room view arrives with M1's focus UI)
    ctx.strokeStyle = '#3E92B8';
    ctx.strokeRect(150.5, 100.5, 92, 68);
    ctx.fillStyle = '#3E92B8';
    ctx.fillRect(192, 97, 10, 4);   // north door port
    ctx.fillRect(192, 167, 10, 4);  // south door port
    ctx.fillRect(147, 130, 4, 10);  // west door port
    ctx.fillRect(241, 130, 4, 10);  // east door port
    ctx.fillStyle = '#25506A';
    ctx.font = '10px monospace';
    ctx.fillText('MODULE', 172, 140);
    // Honesty rule: no fuel system exists — say so, dimly.
    ctx.fillStyle = '#4A5560';
    ctx.font = '12px monospace';
    ctx.fillText('FUEL — NO SENSOR', 14, 120);
    ctx.fillStyle = '#33404E';
    ctx.font = '10px monospace';
    ctx.fillText('SSF ROOM TERMINAL v0', 14, 178);
    screenTex.needsUpdate = true;
  };

  // Boot frame so the prop is never a black rectangle before the first update.
  drawStatus({ roomName: 'FURLONG LOBBY', peers: 0, nodeOnline: false });

  return { group, updateStatus: drawStatus };
}
