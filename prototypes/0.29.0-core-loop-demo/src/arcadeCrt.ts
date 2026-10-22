/**
 * 📺 The arcade cabinet's CRT (#194): a curved tube face with rounded corners,
 * and a screen material that makes the canvas it shows read as a picture tube
 * rather than a flat panel.
 *
 * What a CRT does to a picture, and how each is faked here (all in one
 * fragment pass on the tube's own material, so the rest of the room is
 * untouched and no post-processing pipeline is needed):
 *  - a curved glass face: real geometry (crtFaceGeometry), bulged toward the
 *    viewer, with a squircle outline for the rounded corners; the beam's
 *    barrel bend is a small UV warp on top;
 *  - the picture sits a little in from the tube's edge (the overscan margin):
 *    outside it the face is unlit tube glass;
 *  - scanlines, one per source line (240, the NES's), fading out when the
 *    lines get too small on screen to draw without moiré;
 *  - bleed between pixels: a horizontal smear and a slight red/blue
 *    convergence error, the analogue signal's softness;
 *  - glow (halation): a wide cheap blur added back over the picture;
 *  - not-quite-black: the phosphor's resting grey-green floor;
 *  - flicker: a faint per-frame shimmer and a slow rolling bar;
 *  - a vignette and a soft sheen on the glass.
 * And the cartoon side the issue asks to keep: a saturation push instead of
 * the dingy, desaturated look heavy CRT filters drift into, and a light
 * black-level lift so silhouettes stay crisp.
 */
import * as THREE from 'three';

/** The face's outline: |x|^n + |y|^n = 1 — 2 an ellipse, ∞ a rectangle.
 *  Eight gives the soft-cornered rectangle of a 1980s tube. */
const SQUIRCLE_N = 8;

/**
 * A CRT face `w` × `h`, facing +z, centred on the origin: a grid squeezed
 * into a rounded-corner outline and bulged toward the viewer by `bulge` at
 * the centre (the corners stay at z = 0, the edge midpoints at half). UVs
 * span the face's bounding rectangle, so the picture is not squeezed with it.
 */
export function crtFaceGeometry(w: number, h: number, bulge: number, cols = 32, rows = 24): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      // The bulge follows the square grid, so the outline's corners (the
      // square's) sit at z = 0 and its edge midpoints at half.
      const gu = (i / cols) * 2 - 1;
      const gv = (j / rows) * 2 - 1;
      const z = bulge * (1 - (gu * gu + gv * gv) / 2);
      let u = gu;
      let v = gv;
      const s = Math.max(Math.abs(u), Math.abs(v));
      if (s > 0) {
        // Push the square ring through this point onto the squircle's.
        const k = Math.pow(Math.pow(Math.abs(u / s), SQUIRCLE_N) + Math.pow(Math.abs(v / s), SQUIRCLE_N), 1 / SQUIRCLE_N);
        u /= k;
        v /= k;
      }
      const x = (u * w) / 2;
      const y = (v * h) / 2;
      positions.push(x, y, z);
      uvs.push(x / w + 0.5, y / h + 0.5);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      index.push(a, b, d, a, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

export interface CrtLook {
  /** The picture's share of the face, across and down (the rest is unlit glass). */
  inset: [number, number];
  /** Source picture size in pixels: the scanline count and the bleed's step. */
  lines: [number, number];
  /** Barrel bend of the picture (0 none). */
  warp: number;
  /** How dark the gaps between scanlines get (0 none, 1 black). */
  scan: number;
  /** Halation: how much of the wide blur is added back. */
  glow: number;
  /** 1 leaves colour alone; above 1 pushes it toward the cartoon palette. */
  saturation: number;
  /** The phosphor's resting colour (linear): what black is on this tube. */
  rest: [number, number, number];
}

/** The cabinets' tube: the NES's 256×240 picture, bold scanlines, a gentle
 *  glow, colours pushed a little, and blacks lifted only a few percent. */
export const ARCADE_CRT_LOOK: CrtLook = {
  inset: [0.9, 0.88],
  lines: [256, 240],
  warp: 0.06,
  scan: 0.32,
  glow: 0.35,
  saturation: 1.18,
  rest: [0.004, 0.006, 0.005],
};

/** One clock for every tube: each tube's render ticks it (crtScreenMaterial). */
const crtTime = { value: 0 };

const CRT_UNIFORMS = /* glsl */ `
uniform float uCrtTime;
uniform vec2 uCrtInset;
uniform vec2 uCrtSpan;
uniform vec2 uCrtLines;
uniform float uCrtWarp;
uniform float uCrtScan;
uniform float uCrtGlow;
uniform float uCrtSaturation;
uniform vec3 uCrtRest;
`;

/** Replaces MeshBasicMaterial's map lookup: the picture through the tube. */
const CRT_MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
  // Picture space: ±0.5 across the picture, which sits inside the face —
  // or across a row of faces, this one holding the slice uCrtSpan names
  // (its start and width, 0..1 across the row).
  vec2 crtC = (vec2(uCrtSpan.x + vMapUv.x * uCrtSpan.y, vMapUv.y) - 0.5) / uCrtInset;
  crtC *= 1.0 + uCrtWarp * dot(crtC, crtC);
  vec2 crtUv = crtC + 0.5;
  // The lit picture's rounded corners, with a soft edge.
  const float crtRound = 0.04;
  vec2 crtQ = abs(crtC) - (0.5 - crtRound);
  float crtEdge = length(max(crtQ, 0.0)) + min(max(crtQ.x, crtQ.y), 0.0) - crtRound;
  float crtLit = 1.0 - smoothstep(-0.006, 0.004, crtEdge);
  // Bleed: a horizontal smear, red and blue a touch out of convergence.
  vec2 crtPx = vec2(1.0 / uCrtLines.x, 0.0);
  vec3 crtCol = vec3(
    texture2D(map, crtUv + crtPx * 0.3).r,
    texture2D(map, crtUv).g,
    texture2D(map, crtUv - crtPx * 0.3).b
  );
  crtCol = crtCol * 0.7 + (texture2D(map, crtUv - crtPx).rgb + texture2D(map, crtUv + crtPx).rgb) * 0.15;
  // Halation: light scattering in the thick glass, a wide cheap blur.
  vec2 crtPy = vec2(0.0, 1.0 / uCrtLines.y);
  vec3 crtHalo = texture2D(map, crtUv + crtPx * 3.0).rgb + texture2D(map, crtUv - crtPx * 3.0).rgb
    + texture2D(map, crtUv + crtPy * 1.5).rgb + texture2D(map, crtUv - crtPy * 1.5).rgb;
  crtCol += crtHalo * 0.25 * uCrtGlow;
  // The cartoon side: saturation pushed, not drained.
  float crtLuma = dot(crtCol, vec3(0.299, 0.587, 0.114));
  crtCol = max(mix(vec3(crtLuma), crtCol, uCrtSaturation), 0.0);
  // Scanlines, one per source line; bright lines bloom over their gaps.
  // Faded out once a line is under ~2 screen pixels, before it can moiré.
  float crtRows = crtUv.y * uCrtLines.y;
  float crtBeam = sin(fract(crtRows) * 3.14159265);
  float crtDepth = uCrtScan * (1.0 - smoothstep(0.3, 0.6, fwidth(crtRows))) * (1.0 - clamp(crtLuma, 0.0, 1.0) * 0.5);
  crtCol *= 1.0 - crtDepth * (1.0 - crtBeam);
  // Flicker: a per-frame shimmer and a slow bar rolling up the picture.
  float crtFrame = floor(uCrtTime * 60.0);
  crtCol *= 1.0 + 0.02 * (fract(sin(crtFrame * 12.9898) * 43758.5453) - 0.5);
  crtCol *= 0.975 + 0.025 * sin((crtUv.y - uCrtTime * 0.12) * 6.2831853);
  // Vignette: the beam is weaker toward the corners.
  crtCol *= 1.0 - 0.45 * dot(crtC, crtC);
  // Not-quite-black: the phosphor's resting colour under the picture.
  crtCol = uCrtRest + crtCol * (1.0 - uCrtRest);
  diffuseColor.rgb *= mix(uCrtRest * 0.5, crtCol, crtLit);
  // A soft sheen on the curved glass, high and to the left.
  diffuseColor.rgb += vec3(0.03) * (1.0 - smoothstep(0.0, 0.45, length((vMapUv - vec2(0.28, 0.8)) * vec2(1.0, 1.6))));
#endif
`;

/**
 * The tube's screen material: a MeshBasicMaterial on `texture` (so it fades
 * in with the room, opacity 0 → userData.baseOpacity, like every furniture
 * material) with the CRT pass patched into its map lookup. Call crtTick from
 * the face's onBeforeRender (furniture.ts placeArcadeMonitorBay does) so the
 * flicker runs.
 *
 * `span` lets a row of tubes act as one screen: tube `index` of `count`
 * shows its slice of the picture, and the picture's margin of unlit glass
 * runs round the row's outside edges only. `lines`, when given, is the
 * scanline count as a uniform the caller keeps (and the row's tubes share),
 * for a screen whose picture changes size: set it and every tube follows.
 */
export function crtScreenMaterial(
  texture: THREE.Texture,
  look: CrtLook = ARCADE_CRT_LOOK,
  span: { index: number; count: number } = { index: 0, count: 1 },
  lines: { value: THREE.Vector2 } = { value: new THREE.Vector2(...look.lines) },
): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, toneMapped: false });
  material.userData.baseOpacity = 1;
  material.userData.crtLook = look;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCrtTime = crtTime;
    // Across a row the side margins are the row's, not each tube's.
    shader.uniforms.uCrtInset = { value: new THREE.Vector2(1 - (1 - look.inset[0]) / span.count, look.inset[1]) };
    shader.uniforms.uCrtSpan = { value: new THREE.Vector2(span.index / span.count, 1 / span.count) };
    shader.uniforms.uCrtLines = lines;
    shader.uniforms.uCrtWarp = { value: look.warp };
    shader.uniforms.uCrtScan = { value: look.scan };
    shader.uniforms.uCrtGlow = { value: look.glow };
    shader.uniforms.uCrtSaturation = { value: look.saturation };
    shader.uniforms.uCrtRest = { value: new THREE.Vector3(...look.rest) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CRT_UNIFORMS}`)
      .replace('#include <map_fragment>', CRT_MAP_FRAGMENT);
  };
  return material;
}

/** Advance every tube's flicker clock (seconds). */
export function crtTick(seconds: number): void {
  crtTime.value = seconds;
}
