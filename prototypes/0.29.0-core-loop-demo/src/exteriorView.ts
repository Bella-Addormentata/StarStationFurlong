/**
 * 🛰️ Outside-the-station view (#65 — the S3 seam's first real slice)
 *
 * Zoom level 3 stops being a 2D schematic and becomes the STATION FROM
 * OUTSIDE: the current module wears a hull shell (roof plating, dome,
 * antennas), a planet hangs below (the concept-art vantage), the paired
 * connector chains + far-module boxes stay visible at their true angles
 * (world renders those already — this module only ADDS the exterior dress),
 * and the view is INTERACTIVE:
 *  - click a bellows (flex) joint → a floating BEND editor rewrites that
 *    segment through the same publish path the keypad chips use (every
 *    client's geometry diff rebuilds the chain);
 *  - ☀️ solar panels mount in four roof slots (exteriorDoc, synced) — owners
 *    add from the toolbar and click a panel to dismount it.
 *
 * Integration style matches zoom.ts: window.gameRenderer / window.world are
 * read lazily (no import cycles); zoom.ts calls setExteriorActive on level
 * transitions. Clicks are captured while active so walk-to-point never fires
 * from space. Boot-into-this-view + the "enter room" bubble is #65's next step.
 */

import * as THREE from 'three';
import { readExterior, nextFreeExteriorSlot, writeExteriorSlot } from './exteriorDoc';
import { readDoorPolicy } from './doorPolicy';

const HULL = 0x39445A;
const HULL_DARK = 0x2A3444;
const SEAM = 0x1C262E;
const ACCENT = 0xD4A84B;
const PANEL_BLUE = 0x16294a;

type GameRenderer = { scene?: THREE.Scene; camera?: THREE.Camera; renderer?: { domElement?: HTMLElement } };
const gr = (): GameRenderer => (window as unknown as { gameRenderer?: GameRenderer }).gameRenderer ?? {};
type WorldRef = {
  dockingSystem?: {
    editChainSegment?: (doorId: string, index: number, patch: { bendDeg?: number }) => boolean;
  } | null;
  getPairedVestibuleGroups?: () => Map<string, THREE.Group>;
};
const worldRef = (): WorldRef => (window as unknown as { world?: WorldRef }).world ?? {};

let active = false;
let group: THREE.Group | null = null;
let toolbar: HTMLDivElement | null = null;
let editor: HTMLDivElement | null = null;
let ownerCheck: () => boolean = () => false;
let savedZoom: number | null = null;
const raycaster = new THREE.Raycaster();

export function setExteriorOwnerCheck(cb: () => boolean): void {
  ownerCheck = cb;
}

// ── Build ────────────────────────────────────────────────────────────────────

function box(parent: THREE.Object3D, w: number, h: number, d: number, color: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.45 }));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function buildGroup(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'exteriorView';

  // Hull roof: plating over the 11.8 room at wall-top height, seams + trim +
  // amber corner clamps — the module reads as SEALED from above.
  box(g, 11.8, 0.28, 11.8, HULL, 0, 4.14, 0);
  for (const off of [-2.95, 0, 2.95]) {
    box(g, 0.1, 0.06, 11.6, SEAM, off, 4.32, 0);
    box(g, 11.6, 0.06, 0.1, SEAM, 0, 4.32, off);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    box(g, 0.5, 0.2, 0.5, ACCENT, sx * 5.4, 4.34, sz * 5.4);
  }
  // Observation dome (concept-art hub flavor) + antennas + dish.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x274158, roughness: 0.2, metalness: 0.6, transparent: true, opacity: 0.85 }),
  );
  dome.position.set(0, 4.28, 0);
  g.add(dome);
  const domeRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.5, 0.09, 8, 24),
    new THREE.MeshStandardMaterial({ color: HULL_DARK, roughness: 0.6, metalness: 0.5 }),
  );
  domeRing.rotation.x = Math.PI / 2;
  domeRing.position.set(0, 4.3, 0);
  g.add(domeRing);
  box(g, 0.07, 2.4, 0.07, HULL_DARK, 3.2, 5.4, -3.2);
  box(g, 0.07, 1.7, 0.07, HULL_DARK, -3.6, 5.05, 2.8);
  const dish = new THREE.Mesh(
    new THREE.ConeGeometry(0.7, 0.35, 16, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xB8BFCC, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }),
  );
  dish.position.set(3.2, 5.0, -3.2);
  dish.rotation.z = Math.PI / 3.2;
  g.add(dish);

  // ☀️ Solar panels from the synced slots (roof corners; pylon + tilted array).
  const slotPos: Record<string, { x: number; z: number }> = {
    '0': { x: -4.2, z: -4.2 }, '1': { x: 4.2, z: -4.2 }, '2': { x: -4.2, z: 4.2 }, '3': { x: 4.2, z: 4.2 },
  };
  for (const [slot] of readExterior()) {
    const p = slotPos[slot];
    if (!p) continue;
    const panel = new THREE.Group();
    panel.name = 'solarPanel';
    panel.userData = { isSolarPanel: true, slot };
    box(panel, 0.14, 0.9, 0.14, HULL_DARK, 0, 0.45, 0); // pylon
    const array = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.08, 1.6),
      new THREE.MeshStandardMaterial({ color: PANEL_BLUE, roughness: 0.35, metalness: 0.7, emissive: 0x0a1c3a, emissiveIntensity: 0.6 }),
    );
    array.position.set(0, 1.0, 0);
    array.rotation.z = 0.35; // sun tilt
    panel.add(array);
    for (const gx of [-0.85, 0, 0.85]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 1.62), new THREE.MeshStandardMaterial({ color: HULL_DARK }));
      rib.position.set(gx, 1.0, 0);
      rib.rotation.z = 0.35;
      panel.add(rib);
    }
    panel.position.set(p.x, 4.28, p.z);
    g.add(panel);
  }

  // 🔌 IDA-style docking collars at adapter doors (#67 D2 — built to the
  // owner's pixel-art reference): white soft-goods torus, black capture
  // latches around the rim, concentric silver guide rings with an X brace,
  // a flank equipment box, and BLUE truss struts back to the hull.
  const doorPose: Record<string, { x: number; z: number; ry: number }> = {
    north: { x: 0, z: -5.9, ry: Math.PI },       // collar faces -z
    south: { x: 0, z: 5.9, ry: 0 },
    east:  { x: 5.9, z: 0, ry: Math.PI / 2 },
    west:  { x: -5.9, z: 0, ry: -Math.PI / 2 },
  };
  for (const doorId of ['north', 'south', 'east', 'west']) {
    if (!readDoorPolicy(doorId).adapter) continue;
    const pose = doorPose[doorId];
    const collar = new THREE.Group();
    collar.name = `dockAdapter-${doorId}`;
    const softGoods = new THREE.MeshStandardMaterial({ color: 0xF2EFE6, roughness: 0.85, metalness: 0.08 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.42, 12, 28), softGoods);
    collar.add(ring);
    // Capture latches: 6 black blocks around the rim face.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const latch = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, 0.34, 0.22),
        new THREE.MeshStandardMaterial({ color: 0x14161C, roughness: 0.6, metalness: 0.4 }),
      );
      latch.position.set(Math.cos(a) * 1.35, Math.sin(a) * 1.35, 0.42);
      collar.add(latch);
    }
    // Concentric guide rings + X cross-brace (silver).
    const silver = new THREE.MeshStandardMaterial({ color: 0xB8BFCC, roughness: 0.4, metalness: 0.7 });
    for (const r of [0.85, 0.6]) {
      const guide = new THREE.Mesh(new THREE.TorusGeometry(r, 0.05, 8, 24), silver);
      guide.position.z = 0.18;
      collar.add(guide);
    }
    for (const rz of [Math.PI / 4, -Math.PI / 4]) {
      const brace = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.06), silver);
      brace.position.z = 0.14;
      brace.rotation.z = rz;
      collar.add(brace);
    }
    // Flank equipment box with a dark label plate (the IDA2 crate).
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.62), softGoods);
    crate.position.set(1.55, -0.55, 0.1);
    collar.add(crate);
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.34, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x1C2230, roughness: 0.5 }),
    );
    plate.position.set(1.55, -0.5, 0.42);
    collar.add(plate);
    // Blue truss struts bracing back to the hull (keep the art's blue).
    const trussBlue = new THREE.MeshStandardMaterial({ color: 0x2A6BD4, roughness: 0.55, metalness: 0.5 });
    for (const [sx, sy] of [[-1, 1], [1, 1], [0, -1]] as const) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.9), trussBlue);
      strut.position.set(sx * 0.95, sy * 0.95, -0.55);
      strut.rotation.y = sx * 0.35;
      strut.rotation.x = -sy * 0.3;
      collar.add(strut);
    }
    collar.position.set(pose.x, 2.0, pose.z);
    collar.rotation.y = pose.ry;
    // Push the collar outward along the wall normal so it hangs OFF the hull.
    collar.translateZ(0.85);
    g.add(collar);
  }

  // 🌍 Planet backdrop (the concept art's vantage) + atmosphere shell.
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(42, 48, 32),
    new THREE.MeshStandardMaterial({ color: 0x2a5a8f, roughness: 0.9, metalness: 0.05, emissive: 0x0c2038, emissiveIntensity: 0.5 }),
  );
  planet.position.set(6, -62, 26);
  g.add(planet);
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(43.6, 48, 32),
    new THREE.MeshBasicMaterial({ color: 0x7fb8ff, transparent: true, opacity: 0.10, side: THREE.BackSide }),
  );
  atmo.position.copy(planet.position);
  g.add(atmo);

  return g;
}

function disposeGroup(g: THREE.Group): void {
  const seen = new Set<THREE.BufferGeometry | THREE.Material>();
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry && !seen.has(mesh.geometry)) { seen.add(mesh.geometry); mesh.geometry.dispose(); }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) if (m && !seen.has(m)) { seen.add(m); m.dispose(); }
  });
}

// ── UI (toolbar + bend editor) ───────────────────────────────────────────────

function ensureToolbar(): HTMLDivElement {
  if (toolbar) return toolbar;
  toolbar = document.createElement('div');
  toolbar.id = 'exterior-toolbar';
  toolbar.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(toolbar);
  return toolbar;
}

function renderToolbar(): void {
  const t = ensureToolbar();
  const owner = ownerCheck();
  const free = nextFreeExteriorSlot();
  t.innerHTML = `
    <span id="exterior-toolbar-title">🛰️ EXTERIOR VIEW</span>
    <span id="exterior-toolbar-hint">click a bellows joint to bend it${owner ? ' · click a panel to dismount' : ''}</span>
    ${owner ? `<button type="button" id="exterior-add-solar" ${free === null ? 'disabled' : ''}>☀️ ADD SOLAR PANEL${free === null ? ' (FULL)' : ''}</button>` : ''}
  `;
  t.querySelector('#exterior-add-solar')?.addEventListener('click', () => {
    const slot = nextFreeExteriorSlot();
    if (slot !== null) writeExteriorSlot(slot, { kind: 'solar' });
  });
  t.style.display = 'flex';
}

function closeEditor(): void {
  editor?.remove();
  editor = null;
}

function openBendEditor(doorId: string, index: number, currentBend: number, atX: number, atY: number): void {
  closeEditor();
  editor = document.createElement('div');
  editor.id = 'exterior-bend-editor';
  editor.addEventListener('click', (e) => e.stopPropagation());
  const bends = [-45, -22.5, 0, 22.5, 45];
  editor.innerHTML = `
    <div id="exterior-bend-title">🪗 FLEX JOINT · ${doorId.toUpperCase()} chain #${index + 1} <button type="button" id="exterior-bend-close">✕</button></div>
    <div id="exterior-bend-row">${bends.map((b) =>
      `<button type="button" data-bend="${b}" class="exterior-bend-btn${b === currentBend ? ' current' : ''}">${b > 0 ? '+' : ''}${b}°</button>`).join('')}</div>
    <div id="exterior-bend-note"></div>
  `;
  editor.style.left = `${Math.min(atX, window.innerWidth - 240)}px`;
  editor.style.top = `${Math.min(atY, window.innerHeight - 110)}px`;
  document.body.appendChild(editor);
  editor.querySelector('#exterior-bend-close')?.addEventListener('click', closeEditor);
  editor.querySelectorAll<HTMLButtonElement>('.exterior-bend-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const bend = Number(btn.dataset.bend);
      const ok = worldRef().dockingSystem?.editChainSegment?.(doorId, index, { bendDeg: bend }) ?? false;
      const note = editor?.querySelector('#exterior-bend-note');
      if (note) note.textContent = ok ? `bend set to ${bend}° — synced to everyone` : 'no construction rights on this port';
      if (ok) {
        editor?.querySelectorAll('.exterior-bend-btn').forEach((b) => b.classList.remove('current'));
        btn.classList.add('current');
      }
    });
  });
}

// ── Click routing ────────────────────────────────────────────────────────────

function onClickCapture(e: MouseEvent): void {
  if (!active) return;
  // DOM UI (toolbar, editor, phone, dev menu, the ENTER ROOM bubble…) owns its
  // own clicks — we only claim clicks that reach the GAME CANVAS. Without this
  // guard the capture listener would strangle every button at level 3.
  const t = e.target as HTMLElement | null;
  if (t && t.tagName !== 'CANVAS') return;
  // The exterior view owns canvas clicks — never walk-to-point from space.
  e.stopPropagation();
  const camera = gr().camera;
  if (!camera) return;
  const ndc = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);

  const targets: THREE.Object3D[] = [];
  if (group) targets.push(group);
  const vestibules = worldRef().getPairedVestibuleGroups?.();
  if (vestibules) for (const v of vestibules.values()) targets.push(v);
  const hits = raycaster.intersectObjects(targets, true);
  if (hits.length === 0) { closeEditor(); return; }

  // Walk up from the hit mesh looking for a solar panel or a flex part.
  let node: THREE.Object3D | null = hits[0].object;
  let flexPart: THREE.Object3D | null = null;
  let chainRoot: THREE.Object3D | null = null;
  while (node) {
    if (node.userData?.isSolarPanel) {
      if (ownerCheck()) {
        writeExteriorSlot(node.userData.slot as string, null);
        renderToolbar();
      }
      return;
    }
    if (node.userData?.isConnectorPart && node.userData.kind === 'flex' && !flexPart) flexPart = node;
    if (node.userData?.isConnectorChain) { chainRoot = node; break; }
    node = node.parent;
  }
  if (flexPart && chainRoot) {
    const doorId = chainRoot.userData.doorId as string;
    // Segment index = this part's position among the chain's part children
    // (portals are not parts; order matches state.segments).
    const parts = chainRoot.children.filter((c) => c.userData?.isConnectorPart);
    const index = parts.indexOf(flexPart);
    if (index >= 0) {
      openBendEditor(doorId, index, Number(flexPart.userData.bendDeg ?? 0), e.clientX, e.clientY);
      return;
    }
  }
  closeEditor();
}

// ── ENTER ROOM bubble (#65 boot flow) ────────────────────────────────────────

let enterBubble: HTMLDivElement | null = null;
let bubbleReposition: (() => void) | null = null;

function closeEnterBubble(): void {
  if (bubbleReposition) window.removeEventListener('resize', bubbleReposition);
  bubbleReposition = null;
  enterBubble?.remove();
  enterBubble = null;
}

/** Anchor the boot bubble over the module's dome; clicking it hands off to
 *  onEnter (main.ts drops the player into the room). The camera is static in
 *  the exterior view, so we project once (+ on resize). */
export function showEnterRoomBubble(onEnter: () => void): void {
  closeEnterBubble();
  if (!active) { onEnter(); return; } // exterior unavailable → straight inside
  enterBubble = document.createElement('div');
  enterBubble.id = 'exterior-enter-bubble';
  enterBubble.innerHTML = `<span>🚪 ENTER ROOM</span><div id="exterior-enter-tail"></div>`;
  enterBubble.addEventListener('click', (e) => {
    e.stopPropagation();
    closeEnterBubble();
    onEnter();
  });
  document.body.appendChild(enterBubble);
  bubbleReposition = () => {
    const camera = gr().camera;
    if (!camera || !enterBubble) return;
    const v = new THREE.Vector3(0, 4.6, 0).project(camera);
    enterBubble.style.left = `${((v.x * 0.5 + 0.5) * window.innerWidth).toFixed(0)}px`;
    enterBubble.style.top = `${((-v.y * 0.5 + 0.5) * window.innerHeight - 18).toFixed(0)}px`;
  };
  bubbleReposition();
  window.addEventListener('resize', bubbleReposition);
}

// ── Activation ───────────────────────────────────────────────────────────────

/** Rebuild the exterior dress (solar slots changed / room swapped). */
export function refreshExteriorView(): void {
  if (!active) return;
  const scene = gr().scene;
  if (group) {
    scene?.remove(group);
    disposeGroup(group);
    group = null;
  }
  group = buildGroup();
  scene?.add(group);
  renderToolbar();
}

/** zoom.ts calls this on level transitions (true entering 3, false leaving). */
export function setExteriorActive(on: boolean): void {
  if (on === active) return;
  active = on;
  const scene = gr().scene;
  const camera = gr().camera as (THREE.OrthographicCamera & { zoom: number }) | undefined;
  if (on) {
    group = buildGroup();
    scene?.add(group);
    renderToolbar();
    if (camera && typeof camera.zoom === 'number') {
      savedZoom = camera.zoom;
      camera.zoom = savedZoom * 0.42; // pull back — whole station in frame
      camera.updateProjectionMatrix?.();
    }
    window.addEventListener('click', onClickCapture, true);
  } else {
    window.removeEventListener('click', onClickCapture, true);
    closeEditor();
    closeEnterBubble();
    if (toolbar) toolbar.style.display = 'none';
    if (group) {
      scene?.remove(group);
      disposeGroup(group);
      group = null;
    }
    if (camera && savedZoom !== null) {
      camera.zoom = savedZoom;
      camera.updateProjectionMatrix?.();
      savedZoom = null;
    }
  }
}

export function isExteriorActive(): boolean {
  return active;
}
