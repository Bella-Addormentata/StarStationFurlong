/**
 * 📺 The cabinets' CRT tube (#194): a face that bulges toward the player
 * with rounded corners, and a screen material that keeps the furniture fade
 * contract while patching the CRT pass into its map lookup.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ARCADE_CRT_LOOK, crtFaceGeometry, crtScreenMaterial } from './arcadeCrt';

describe('the CRT face', () => {
  const w = 0.6;
  const h = 0.45;
  const bulge = 0.02;
  const geo = crtFaceGeometry(w, h, bulge);
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');

  it('bulges toward the viewer: highest at the centre, flat at the corners', () => {
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    expect(box.max.z).toBeCloseTo(bulge, 6);
    expect(box.min.z).toBeGreaterThanOrEqual(-1e-9);
    expect(box.max.x - box.min.x).toBeCloseTo(w, 6);
    expect(box.max.y - box.min.y).toBeCloseTo(h, 6);
    // Normals lean outward toward the edges, as on a curved glass face.
    const normals = geo.getAttribute('normal');
    let rightmost = 0;
    for (let i = 0; i < pos.count; i++) if (pos.getX(i) > pos.getX(rightmost)) rightmost = i;
    expect(normals.getX(rightmost)).toBeGreaterThan(0);
    expect(normals.getZ(rightmost)).toBeGreaterThan(0.9);
  });

  it('has rounded corners: nothing reaches the bounding rectangle’s corner', () => {
    let nearest = Infinity;
    for (let i = 0; i < pos.count; i++) {
      nearest = Math.min(nearest, Math.hypot(pos.getX(i) - w / 2, pos.getY(i) - h / 2));
    }
    expect(nearest).toBeGreaterThan(0.01);
  });

  it('maps the picture over its bounding rectangle, not squeezed with the outline', () => {
    for (let i = 0; i < pos.count; i++) {
      expect(uv.getX(i)).toBeCloseTo(pos.getX(i) / w + 0.5, 6);
      expect(uv.getY(i)).toBeCloseTo(pos.getY(i) / h + 0.5, 6);
    }
  });
});

describe('the CRT screen material', () => {
  it('fades in like furniture and is not tone-mapped', () => {
    const texture = new THREE.Texture();
    const mat = crtScreenMaterial(texture);
    expect(mat.map).toBe(texture);
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBe(0);
    expect(mat.userData.baseOpacity).toBe(1);
    expect(mat.toneMapped).toBe(false);
  });

  it('patches the CRT pass into the map lookup, with its uniforms', () => {
    const mat = crtScreenMaterial(new THREE.Texture());
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: '',
      fragmentShader: '#include <common>\nvoid main() {\n#include <map_fragment>\n}',
    };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
    expect(shader.fragmentShader).toContain('uniform float uCrtScan;');
    expect(shader.fragmentShader).toContain('uCrtRest + crtCol');
    for (const name of ['uCrtTime', 'uCrtInset', 'uCrtLines', 'uCrtWarp', 'uCrtScan', 'uCrtGlow', 'uCrtSaturation', 'uCrtRest']) {
      expect(shader.uniforms[name]).toBeDefined();
    }
    expect(shader.uniforms.uCrtLines.value).toEqual(new THREE.Vector2(...ARCADE_CRT_LOOK.lines));
  });

  it('keeps the cartoon look: colour pushed, blacks lifted only a few percent', () => {
    expect(ARCADE_CRT_LOOK.saturation).toBeGreaterThan(1);
    for (const c of ARCADE_CRT_LOOK.rest) expect(c).toBeLessThan(0.01); // linear; ≲ 5% on screen
    expect(ARCADE_CRT_LOOK.inset[0]).toBeLessThan(1); // the picture stays off the tube's edge
    expect(ARCADE_CRT_LOOK.inset[1]).toBeLessThan(1);
  });
});
