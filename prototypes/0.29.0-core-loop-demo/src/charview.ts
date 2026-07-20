/**
 * charview — DEV character-viewer mode (`?charview` URL param).
 *
 * Boots straight into an auto-orbiting 360° turntable of the VoxelCharacter
 * so model changes can be reviewed with ZERO clicks: no room entry, no
 * network, no game UI. Intended for the art-iteration loop while the rig is
 * being matched to the owner's reference sheet ("SPACE STATION REFERENCE
 * IMAGE 85"); the branch lives behind the URL param so the normal game boot
 * is untouched.
 *
 * Controls:
 *   - (nothing)  camera orbits the character continuously
 *   - Space      toggle idle ↔ walk so the gait can be checked
 *
 * Automation hooks (used by the headless screenshot driver):
 *   window.__charview.setYaw(rad)   freeze auto-orbit at an exact azimuth
 *   window.__charview.setState(s)   force an animation state ('idle'|'walk'|…)
 */

import * as THREE from 'three';
import { VoxelCharacter, type CharacterState } from './voxelCharacter';

/** Full orbit period of the auto-turntable (seconds per 360°). */
const ORBIT_PERIOD_S = 14;

export function startCharView(): void {
  // ── Stage ─────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Sit above any UI that statically-imported game modules may have added.
  renderer.domElement.style.cssText =
    'position:fixed; inset:0; z-index:9000; display:block;';
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x272e3c); // neutral slate — white fur pops

  // Three-point studio lighting tuned for the white toon fur: hemisphere
  // base, warmish key, cool fill, strong rim for edge separation.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x39445a, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  key.position.set(3.5, 6.0, 4.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9fb4d8, 0.5);
  fill.position.set(-4.0, 2.5, -1.0);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.0);
  rim.position.set(-2.5, 4.0, -4.5);
  scene.add(rim);

  // Ground disc + soft contact spot so the character doesn't float in void
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(3.4, 64),
    new THREE.MeshToonMaterial({ color: 0x39404f })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const contact = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 48),
    new THREE.MeshBasicMaterial({ color: 0x2c3340 })
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.005;
  scene.add(contact);

  // ── The character ─────────────────────────────────────────────────────
  const rig = new VoxelCharacter(scene);
  rig.setState('idle', 0);
  let state: CharacterState = 'idle';

  // ── Camera + orbit ────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(
    36,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  let yaw = Math.PI * 0.15;   // start on a pleasant ¾ angle
  let autoOrbit = true;
  const CAM_R = 6.5;
  const CAM_H = 1.9;
  const LOOK_AT = new THREE.Vector3(0, 1.5, 0);

  const applyCamera = () => {
    camera.position.set(
      Math.sin(yaw) * CAM_R,
      CAM_H,
      Math.cos(yaw) * CAM_R
    );
    camera.lookAt(LOOK_AT);
  };

  // Angle readout chip (bottom-left) — which side of the sheet is on screen
  const chip = document.createElement('div');
  chip.style.cssText = `
    position:fixed; left:16px; bottom:14px; z-index:9001;
    font:12px 'SF Mono','Consolas',monospace; letter-spacing:1px;
    color:#c8d2e4; background:rgba(10,14,24,0.75);
    border:1px solid rgba(200,210,228,0.25); border-radius:8px;
    padding:6px 10px; user-select:none;
  `;
  document.body.appendChild(chip);
  const refreshChip = () => {
    const deg = ((THREE.MathUtils.radToDeg(yaw) % 360) + 360) % 360;
    chip.textContent =
      `CHARACTER VIEWER · ${deg.toFixed(0)}° · ${state.toUpperCase()}` +
      ` · SPACE = idle/walk`;
  };

  // ── Controls + automation hooks ───────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      state = state === 'idle' ? 'walk' : 'idle';
      rig.setState(state, 0);
      e.preventDefault();
    }
  });
  (window as unknown as Record<string, unknown>).__charview = {
    setYaw(rad: number): void {
      autoOrbit = false;
      yaw = rad;
      applyCamera();
    },
    setState(s: CharacterState): void {
      state = s;
      rig.setState(s, 0);
    },
  };

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── Loop ──────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (autoOrbit) yaw += (Math.PI * 2 * dt) / ORBIT_PERIOD_S;
    applyCamera();
    refreshChip();
    rig.update();
    renderer.render(scene, camera);
  });

  console.log('✅ Character viewer started (?charview) — auto-orbit turntable');
}
