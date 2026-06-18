/**
 * Three.js Renderer Setup
 * Orthographic (parallel-projection) camera locked to a fixed isometric angle.
 * Camera position and orientation never change after initialization.
 */

import * as THREE from 'three';

// Half-size of the world region shown by the orthographic frustum (world units)
const VIEW_SIZE = 14;

// Global renderer state (accessible from main.ts)
declare global {
  interface Window {
    gameRenderer: {
      renderer: THREE.WebGLRenderer;
      camera: THREE.OrthographicCamera;
      scene: THREE.Scene;
    };
  }
}

/**
 * Compute orthographic frustum bounds for the current viewport aspect ratio.
 */
function orthoFrustum(aspect: number) {
  const halfH = VIEW_SIZE / 2;
  const halfW = halfH * aspect;
  return { left: -halfW, right: halfW, top: halfH, bottom: -halfH };
}

/**
 * Initialize Three.js renderer with a locked orthographic camera.
 */
export function initRenderer() {
  // Get container
  const container = document.getElementById('app');
  if (!container) {
    throw new Error('App container not found');
  }

  // Create scene
  const scene = new THREE.Scene();

  // Bright cerulean — matches vivid Earth-atmosphere blue
  scene.background = new THREE.Color(0x0a2a5e);

  // Fog matches the bright blue void tone
  scene.fog = new THREE.FogExp2(0x0d3060, 0.015);

  // ── Orthographic (parallel-projection) camera ──────────────────────────────
  // The frustum is symmetric around the world origin; VIEW_SIZE controls how
  // many world-units are visible vertically.  Aspect ratio stretches it
  // horizontally so nothing is distorted.
  const aspect = window.innerWidth / window.innerHeight;
  const f = orthoFrustum(aspect);
  const camera = new THREE.OrthographicCamera(
    f.left, f.right, f.top, f.bottom,
    0.1,   // near
    1000   // far
  );

  // ── Fixed isometric angle ──────────────────────────────────────────────────
  // Position the camera along the (1, 1.2, 1) diagonal so we get a slightly
  // elevated three-quarter view of the lobby platform.  This position is
  // intentionally never modified after this point.
  camera.position.set(22, 26, 22);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  // ── Pixelated retro renderer ──────────────────────────────────────────────
  // Render the 3D world at a fixed low internal resolution (640×360) and let
  // the browser scale the canvas up to fill the viewport using nearest-neighbor
  // (pixelated) filtering.  antialias is disabled so geometry edges stay hard
  // and chunky — matching the gritty 32-bit isometric aesthetic.
  const RENDER_W = 640;
  const RENDER_H = 360;

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  // Pass `false` as the third argument so Three.js does NOT set the canvas CSS
  // width/height — the CSS rule below stretches the small buffer to full-screen.
  renderer.setSize(RENDER_W, RENDER_H, false);
  renderer.setPixelRatio(1); // always 1:1 — no HiDPI upsampling
  renderer.shadowMap.enabled = false;

  container.appendChild(renderer.domElement);

  // Lighting setup
  setupLighting(scene);

  // Procedural warm-nebula background (skysphere + star field)
  buildNebulaBackground(scene);

  // Handle window resize — update frustum bounds only; render resolution stays
  // locked at RENDER_W × RENDER_H so the pixelated look is preserved.
  window.addEventListener('resize', () => {
    const a = window.innerWidth / window.innerHeight;
    const nf = orthoFrustum(a);
    camera.left   = nf.left;
    camera.right  = nf.right;
    camera.top    = nf.top;
    camera.bottom = nf.bottom;
    camera.updateProjectionMatrix();
  });

  // Store globally for access from main loop
  window.gameRenderer = { renderer, camera, scene };

  console.log('✅ Renderer initialized (orthographic camera, locked)');

  return { renderer, camera, scene };
}

/**
 * Setup scene lighting
 */
function setupLighting(scene: THREE.Scene) {
  // Ambient light - balanced to work with galaxy background
  const ambientLight = new THREE.AmbientLight(0x8899bb, 0.5);
  scene.add(ambientLight);

  // Main directional light - bright overhead station lights
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.9);
  directionalLight.position.set(5, 10, 5);
  directionalLight.castShadow = false;
  scene.add(directionalLight);

  // Cyan tech accent light (left corner) - softer to not overpower background
  const accentLight1 = new THREE.PointLight(0x00ccff, 0.4, 15);
  accentLight1.position.set(-4, 1.5, -4);
  scene.add(accentLight1);

  // Orange tech accent light (right corner) - softer
  const accentLight2 = new THREE.PointLight(0xff8800, 0.3, 15);
  accentLight2.position.set(4, 1.5, 4);
  scene.add(accentLight2);

  // Hemisphere light for overall illumination
  const hemisphereLight = new THREE.HemisphereLight(0xaaccff, 0x445566, 0.4);
  scene.add(hemisphereLight);

  console.log('✅ Lighting configured (warm nebula mode)');
}

// ─── Procedural Nebula Background ────────────────────────────────────────────

let nebulaUniforms: { uTime: { value: number } } | null = null;

/**
 * Tick the nebula time uniform — call every frame with total elapsed seconds.
 */
export function updateNebulaBackground(time: number): void {
  if (nebulaUniforms) nebulaUniforms.uTime.value = time;
}

/**
 * Build a warm artistic nebula skysphere + layered star field.
 * Entirely procedural — no image assets needed.
 */
function buildNebulaBackground(scene: THREE.Scene): void {
  // ── Skysphere shaders ────────────────────────────────────────────────────
  const vertexShader = /* glsl */`
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPos.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const fragmentShader = /* glsl */`
    varying vec3 vWorldPosition;
    uniform float uTime;

    float hash(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i),                  hash(i + vec2(1.0, 0.0)), f.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
        f.y
      );
    }

    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      mat2 rot = mat2(0.8660, 0.5, -0.5, 0.8660);
      for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p  = rot * p * 2.1 + vec2(31.416, 27.183);
        a *= 0.5;
      }
      return v;
    }

    void main() {
      vec3 dir = normalize(vWorldPosition);

      // Spherical UV
      float phi   = atan(dir.z, dir.x);
      float theta = asin(clamp(dir.y, -1.0, 1.0));
      vec2 uv = vec2(phi / 6.28318 + 0.5, theta / 3.14159 + 0.5);

      // Slow drift
      vec2 dUV = uv + vec2(uTime * 0.0028, uTime * 0.0012);

      // ── GALACTIC CORE DIRECTION ─────────────────────────────────────────
      // Core is toward +X, slightly tilted — gives the sky a clear "home" side
      vec3 coreDir = normalize(vec3(0.72, -0.10, 0.25));
      float coreProx = dot(dir, coreDir) * 0.5 + 0.5;   // 0 = void, 1 = core
      float coreGlow = pow(coreProx, 2.2);               // concentrated dome

      // ── BASE SKY: vivid Earth-atmosphere blue (void) → warm dark (core) ─────
      // Void side: bright cerulean like NASA Earth photos
      vec3 col = mix(vec3(0.035, 0.165, 0.480), vec3(0.018, 0.012, 0.008), coreGlow);

      // ── GALACTIC CORE GLOW — amber-gold dome ───────────────────────────
      // The warm heart of the galaxy: amber → deep gold, soft smooth falloff
      col += vec3(0.82, 0.48, 0.08) * pow(coreGlow, 3.5) * 0.55;
      col += vec3(1.00, 0.72, 0.22) * pow(coreGlow, 7.0) * 0.40;  // bright inner halo

      // ── MILKY WAY BAND — star-dense equatorial strip ───────────────────
      // A wide band of glowing star clusters arcing across the horizon
      float bandY   = clamp(1.0 - abs(dir.y) * 2.8, 0.0, 1.0);
      float bandN   = fbm(dUV * 1.8 + vec2(4.50, 1.20));
      float band    = bandY * (0.55 + bandN * 0.45);
      // Bright sky-blue in void half, warm peach-white in core half
      vec3 bandCol  = mix(vec3(0.30, 0.62, 0.98), vec3(0.95, 0.80, 0.55), coreProx);
      col += bandCol * pow(band, 2.0) * 0.38;

      // ── DUST LANES — dark FBM cuts through the bright band ─────────────
      float dust = fbm(dUV * 2.6 + vec2(9.10, 3.30));
      float dustMask = bandY * coreProx * pow(max(dust - 0.40, 0.0), 1.2) * 1.5;
      col *= max(1.0 - dustMask * 0.72, 0.28);  // subtract luminosity for depth

      // ── EMISSION NEBULA — crimson-orange wisps near the band ───────────
      float ne1 = fbm(dUV * 3.2 + vec2(1.70, 7.80));
      col += vec3(0.95, 0.22, 0.08) * pow(max(ne1 - 0.46, 0.0), 2.2) * bandY * coreProx * 0.50;

      // ── VOID-SIDE NEBULA — cold teal wisps, sparse ─────────────────────
      float voidSide = 1.0 - coreProx;
      float ne2 = fbm(dUV * 2.4 + vec2(6.30, 11.20));
      col += vec3(0.10, 0.68, 1.00) * pow(max(ne2 - 0.50, 0.0), 2.4) * voidSide * 0.40;

      // ── SCATTERED STAR BRIGHTNESS boost in core zone ───────────────────
      // Simulates dense unresolved star clusters glowing in the core direction
      float sc = fbm(dUV * 5.5 + vec2(3.30, 0.80));
      col += vec3(1.00, 0.90, 0.70) * pow(max(sc - 0.52, 0.0), 3.0) * coreGlow * 0.30;

      // ── LARGE-SCALE LUMINOSITY VARIATION ───────────────────────────────
      float lum = fbm(uv * 0.45 + vec2(0.50, 0.50));
      col *= 0.55 + lum * 0.90;

      // ── REINHARD TONE-MAP + GAMMA ───────────────────────────────────────
      col = col / (col + vec3(1.0));
      col = pow(max(col, vec3(0.0)), vec3(0.4545));

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  nebulaUniforms = { uTime: { value: 0.0 } };

  const skyGeo = new THREE.SphereGeometry(500, 64, 64);
  const skyMat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: nebulaUniforms,
    side: THREE.BackSide,
    depthWrite: false,
  });
  (skyMat as THREE.ShaderMaterial & { fog: boolean }).fog = false;
  scene.add(new THREE.Mesh(skyGeo, skyMat));

  // ── Star field layers — three radii for visual depth ─────────────────────
  addStarField(scene, 4000, 460, 1.0); // distant: dense Milky Way carpet
  addStarField(scene, 700,  360, 1.6); // mid: colour variety
  addStarField(scene, 100,  280, 2.8); // accent: bright foreground stars

  console.log('✅ Galaxy Arm background built (procedural, directional core glow)');
}

/**
 * Add a star-field Points layer placed on a sphere of the given radius.
 * sizePx is screen-pixel size (sizeAttenuation: false) for crisp pinpoint stars.
 */
function addStarField(
  scene: THREE.Scene,
  count: number,
  radius: number,
  sizePx: number
): void {
  const positions = new Float32Array(count * 3);
  const colors    = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    // Uniform sphere sampling — rejection method
    let x = 0, y = 0, z = 0, d2 = 0;
    do {
      x  = Math.random() * 2 - 1;
      y  = Math.random() * 2 - 1;
      z  = Math.random() * 2 - 1;
      d2 = x * x + y * y + z * z;
    } while (d2 > 1 || d2 === 0);
    const inv = radius / Math.sqrt(d2);
    positions[i * 3]     = x * inv;
    positions[i * 3 + 1] = y * inv;
    positions[i * 3 + 2] = z * inv;

    // Warm colour palette: cream-white · gold · blue-white · cyan accent
    const r = Math.random();
    if (r < 0.60) {
      // Warm cream-white
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 0.82;
    } else if (r < 0.78) {
      // Gold
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.80; colors[i * 3 + 2] = 0.35;
    } else if (r < 0.92) {
      // Blue-white
      colors[i * 3] = 0.82; colors[i * 3 + 1] = 0.90; colors[i * 3 + 2] = 1.0;
    } else {
      // Cyan accent (mirrors station accent lights)
      colors[i * 3] = 0.20; colors[i * 3 + 1] = 0.88; colors[i * 3 + 2] = 1.0;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

  const mat = new THREE.PointsMaterial({
    size: sizePx,
    sizeAttenuation: false, // crisp pixel-size stars at every distance
    vertexColors: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  (mat as THREE.PointsMaterial & { fog: boolean }).fog = false;
  scene.add(new THREE.Points(geo, mat));
}
