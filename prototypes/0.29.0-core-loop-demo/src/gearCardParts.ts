/**
 * ⚙ Pieces of the settings-gear cards (settingsGear.ts): the HTML, in the
 * craps/roulette table card's style, and the gear pick. They import only
 * three, so devices.ts and the tests can use them without pulling in the
 * focus and room modules.
 */

import type * as THREE from 'three';

const GOLD = '#D4A84B';
const GOLD_BRIGHT = '#F0C060';
const DIM = 'rgba(212,168,75,0.55)';

/** A card button in the table-card style; owner actions use `enabled`. */
export function gearButton(act: string, label: string, enabled = true): string {
  return `<button data-act="${act}" ${enabled ? '' : 'disabled'} style="padding:6px 10px;background:rgba(212,168,75,${enabled ? 0.12 : 0.04});border:1px solid rgba(212,168,75,${enabled ? 0.5 : 0.18});border-radius:6px;color:${enabled ? GOLD_BRIGHT : DIM};font:inherit;font-size:10px;font-weight:800;letter-spacing:1.2px;cursor:${enabled ? 'pointer' : 'not-allowed'};">${label}</button>`;
}

/** A section of rules or facts in the card's body style. */
export function gearSection(lines: readonly string[]): string {
  return `<div style="font-size:10px;line-height:1.7;color:${GOLD};border-top:1px solid rgba(212,168,75,0.18);padding-top:8px;">${
    lines.map((line) => `<div>${line}</div>`).join('')
  }</div>`;
}

/** The item whose ⚙️ gear `ray` hits first, or null. */
export function pickSettingsGear(scene: THREE.Object3D, rayIn: THREE.Raycaster): string | null {
  const gears: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (typeof child.userData?.settingsGear === 'string' && child.visible) gears.push(child);
  });
  if (gears.length === 0) return null;
  const hit = rayIn.intersectObjects(gears, false)[0];
  return hit ? (hit.object.userData.settingsGear as string) : null;
}
