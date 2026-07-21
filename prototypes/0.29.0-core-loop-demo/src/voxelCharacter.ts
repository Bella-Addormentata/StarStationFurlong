/**
 * VoxelCharacter — Rigged Fox Anthro State Machine (white reference-sheet pass)
 *
 * Rebuilt to mirror the owner's character turnaround sheet
 * ("SPACE STATION REFERENCE IMAGE 85" — front / ¾ / side / back / face views):
 * an all-WHITE chibi fox. Per that sheet, this pass changes the sculpt to:
 *
 *  - All-white fur everywhere (shading comes from the toon bands, matching
 *    the sheet's soft grey line-art shading). Dark features are ONLY the
 *    eyes, brows, nose and mouth — charcoal, not black.
 *  - MUCH bigger triangular ears (nearly head-height) with grey inner-ear
 *    cavities and base fluff wisps.
 *  - A small spiky fur tuft on top of the head between the ears.
 *  - Spiky cheek ruffs on both sides of the head.
 *  - A flat cute face: barely-protruding muzzle bump, small charcoal nose,
 *    thin smile curve with one tiny fang. Big dark GLOSSY eyes (charcoal
 *    fill + big white shines) with thin eyebrow strokes — replaces the old
 *    cream-sclera/teal-iris anime eyes.
 *  - Pear-shaped plump torso (narrow shoulders, round belly) with a spiky
 *    chest-bib tuft.
 *  - Stubby arms ending in rounded mitten paws that hang slightly outward;
 *    no gloves, no visible pads (sheet shows plain white mittens).
 *  - Short stub legs with rounded three-toed feet (toe clefts read through
 *    the outline shells).
 *  - The signature BIG flame-shaped tail: attaches at the tail-bone, sweeps
 *    back then curls UP to chin height, serrated with fluff spikes along the
 *    edge — replaces the old drooping three-ball stub.
 *
 * Rig bones, state table, outfit system and all public API are untouched —
 * this is a re-skin of the meshes hanging off the same skeleton:
 *  - MeshToonMaterial + 4-band gradient map for cel shading
 *  - Inverted-hull outline shell around every silhouette mesh (outline is
 *    now soft grey — dark brown lines would read harsh against white fur)
 *  - Subtle breathing scale + occasional ear twitches
 *
 * Public API preserved: constructor(scene), masterGroup, setState, update.
 * Consumers: player.ts (local) and world.ts (remote peer avatars).
 * NOTE: applyPeerTint hue-shifts materials — a hue shift on pure white is a
 * no-op, so while the model is all-white, peers are distinguished by their
 * name tags / chat only. Outfit recolors still work (roles still tagged).
 *
 * Outfit system (TR3, issue #35 — ADDITIVE, frozen API untouched):
 *  - _build* meshes whose material color comes from a swappable PAL entry are
 *    tagged with userData.paletteRole ('fur'|'furDeep'|'cream'|'accent').
 *  - setOutfit(outfit)/clearOutfit() recolor those materials with ABSOLUTE
 *    setHex (offsetHSL is cumulative — #27's documented trap), dedupe shared
 *    materials via a Set, skip the shared OUTLINE_MAT, and mirror the recolor
 *    into emissive where tmat() seeded it from the same hex. Originals are
 *    captured on first apply so restore/re-apply are exact.
 *  - attachAccessory/removeAccessory: one procedural head-slot accessory
 *    (cap/visor/scarf) parented to the head group, so it follows every
 *    walk/sit/twitch animation for free.
 */

import * as THREE from 'three';
import type { OutfitDef, PaletteRole, AccessoryKind } from './outfits';

export type CharacterState = 'idle' | 'walk' | 'sit_chair' | 'sit_ground' | 'sleep' | 'swim' | 'dive';

interface PoseState {
  /** World-space Y for the torso root (lower values = seated) */
  rootY: number;
  /** Target X-rotation for both legs; null = computed dynamically (walk cycle) */
  legRotX: number | null;
  /** Target X-rotation for both arms; null = computed dynamically (walk cycle) */
  armRotX: number | null;
  /**
   * Whole-body recline about X (🛏️ bunk beds): the torso group carries head /
   * arms / legs / tail, so tipping it lays the entire rig down in one joint.
   * Negative = onto the back, face up (head swings toward local -z — the
   * OPPOSITE of the facing direction). Undefined ⇒ upright (0).
   */
  bodyRotX?: number;
}

// Standing rootY math (issue #21 — feet below floor): torso.y ends up at
// rootY − 0.15, leg pivots hang at torso − 0.30, and the lowest foot-pad
// geometry extends −0.7328 below the leg pivot. At rootY 1.0 the pads sank to
// world y ≈ −0.18; rootY 1.18 puts the pad bottoms at ≈ −0.003 (flush with the
// y=0 floor). Walk bounce is strictly upward, so no transient dip re-appears.
const STATES: Record<CharacterState, PoseState> = {
  idle:       { rootY: 1.18, legRotX: 0,             armRotX: 0             },
  walk:       { rootY: 1.18, legRotX: null,          armRotX: null          },
  sit_chair:  { rootY: 0.5,  legRotX: -Math.PI / 2,  armRotX: -Math.PI / 6  },
  sit_ground: { rootY: -0.2, legRotX: -Math.PI / 2,  armRotX: 0             },
  // 🛏️ Lying on the back (bunk berths): legs/arms straight so they trail the
  // reclined torso horizontally. rootY holds the torso pivot high enough that
  // the oversized chibi skull squishes into the pillow rather than through the
  // mattress; the berth's elevation (top bunk) rides on the PLAYER MESH y, not
  // here, so one pose serves both bunks.
  sleep:      { rootY: 0.62, legRotX: 0,             armRotX: 0,            bodyRotX: -Math.PI / 2 },
  // 🏊 Swimming (pool seats): the PLAYER MESH y sits at POOL_SWIM_Y (-0.20),
  // so a low rootY sinks the torso beneath the water plane (y≈-0.03) and
  // leaves the chibi head bobbing above the surface — Habbo Lido style. Legs
  // tuck forward; arms paddle in a dedicated update() branch (null = dynamic).
  swim:       { rootY: -0.05, legRotX: -Math.PI / 2, armRotX: null          },
  // 🏊‍♂️ Dive arc: face-down superman — POSITIVE bodyRotX tips onto the FRONT
  // (sleep's -π/2 is onto the back), arms stretched past the head.
  dive:       { rootY: 0.9,  legRotX: 0,             armRotX: -Math.PI * 0.85, bodyRotX: Math.PI * 0.45 },
};

/** Snap a continuous angle to the nearest of 8 compass directions (π/4 steps). */
export function snapTo8Ways(angle: number): number {
  const PI_4 = Math.PI / 4;
  return Math.round(angle / PI_4) * PI_4;
}

/**
 * Resting side-set of the tail brush (radians about the tail group's local
 * Z — which maps to a yaw about world-up, swinging the WHOLE drooping brush
 * sideways; rotating local Y would twist a drooped tail's plane instead).
 * NEGATIVE puts the brush on the character's LEFT, which reads as
 * VIEWER-RIGHT when the character faces the camera — matching where the
 * sheet draws the tail in its front and ¾ hero views. (The sheet's back
 * view mirrors it for composition; the hero views win.) Idle sways around
 * this offset; walk/swim halve it so the brush streams behind.
 */
const TAIL_REST_YAW = -0.45;

// Reference-sheet palette — ALL-WHITE fur; the only dark marks are the face
// features, in soft charcoal (never pure black — the sheet's linework is
// grey). fur / furDeep / cream / accent keep SEPARATE material instances even
// where the hex is identical, so the outfit palette-role recolors (issue #35)
// can still dye each slot independently.
const PAL = {
  fur:        0xffffff,  // main white body fur (role 'fur')
  furShade:   0xd4d8e0,  // soft cool-grey — inner-ear cavity fill (role 'furDeep')
  furShadeLo: 0xb9c0cc,  // deeper grey — innermost ear cavity accent
  cream:      0xffffff,  // chest bib + muzzle zone (role 'cream' — white for now)
  paw:        0xffffff,  // mitten paws + feet (role 'accent' — white for now)
  nose:       0x2e2c32,  // charcoal — nose, mouth line
  noseHi:     0xffffff,  // nose highlight speck
  fang:       0xffffff,  // tiny visible tooth
  outline:    0x99a0ac,  // soft grey line-art outline (matches sheet linework)
};

// ── Toon gradient (smooth airbrush ramp) ───────────────────────────────────
// A 64×1 DataTexture used as MeshToonMaterial.gradientMap, LINEAR-filtered.
// Hard nearest-filter bands (4-step, then 8-step) read as flat grey blobs on
// the all-white fur — nothing like the sheet. A smooth ramp with lifted
// shadows (floor 118, soft-knee curve) gives the sheet's soft airbrushed
// grey shading while still clamping how dark the white fur can fall.
function createGradientMap(): THREE.DataTexture {
  const STEPS = 64;
  const data = new Uint8Array(STEPS);
  for (let i = 0; i < STEPS; i++) {
    const t = i / (STEPS - 1);
    // Soft-knee lift: shadows bottom out at 96, highlights reach 255. The
    // earlier 118 floor (plus heavy emissive) left the white fur nearly
    // shadeless — flat paper. A deeper toe gives the volumetric form
    // shading that makes the model read 3D like the sheet.
    data[i] = Math.round(96 + 159 * Math.pow(t, 0.9));
  }
  const tex = new THREE.DataTexture(data, STEPS, 1, THREE.RedFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
const GRAD = createGradientMap();

// Toon material factory — cel-shaded with a subtle emissive tint so colours
// stay readable in dim light. Emissive is kept LOW: it adds flat unshaded
// brightness, and on white fur anything above ~0.06 washes out the form
// shading that makes the model read 3D.
function tmat(hex: number, opts: { emissiveBoost?: number } = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color: hex,
    emissive: hex,
    emissiveIntensity: Math.min(opts.emissiveBoost ?? 0.05, 0.06),
    gradientMap: GRAD,
  });
}

// Basic (unlit) material — used for the nose highlight speck.
// These are stylistic marks that shouldn't cast/receive shading.
function bmat(hex: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: hex });
}

// Shared outline material — ONE instance shared across every outline shell of
// EVERY VoxelCharacter instance. Exported so despawn/tint code can skip it:
// disposing or recoloring it would break all rigs at once.
export const OUTLINE_MAT = new THREE.MeshBasicMaterial({
  color: PAL.outline,
  side: THREE.BackSide,
});

/**
 * Global linework weight. The sheet's outlines are thin and delicate; the
 * caller-supplied thicknesses date from the chunky-mascot pass, so one knob
 * scales every shell down uniformly (accessories included) instead of
 * retuning ~40 call sites.
 */
const OUTLINE_FINENESS = 0.55;

/**
 * Build an inverted-hull outline shell for a mesh. Renders only back faces
 * of a scaled-up copy of the mesh, giving a clean grey border wherever the
 * silhouette turns away from the camera.
 */
function outline(host: THREE.Mesh, thickness = 0.02): THREE.Mesh {
  const shell = new THREE.Mesh(host.geometry, OUTLINE_MAT);
  shell.scale.multiplyScalar(1 + thickness * OUTLINE_FINENESS);
  shell.position.copy(host.position);
  shell.rotation.copy(host.rotation);
  shell.renderOrder = -1;
  return shell;
}

/** Small helper: add a mesh to a group AND drop an outline shell next to it. */
function addWithOutline(group: THREE.Group, mesh: THREE.Mesh, thickness = 0.02): void {
  group.add(mesh);
  group.add(outline(mesh, thickness));
}

/**
 * Soft fur-tuft geometry — a TEARDROP: round bulging base easing into a soft
 * point. Built by pinching a sphere's upper hemisphere toward the pole (then
 * recomputing normals), so the silhouette is a smooth continuous curve with
 * no cone facets — the "smooth curves / natural feel" the reference sheet's
 * fur spikes have. Every tuft on the rig (ears, head tuft, cheek ruffs,
 * chest bib, tail flames) is one of these.
 *
 * The base BOTTOM is pinned at the local origin (tip at +h on local +Y), so
 * positioning a mesh at a surface point and rotating it splays the tuft
 * outward from that point like real fur.
 */
function fluffGeo(
  r: number,
  h: number,
  wSeg = 24,
  hSeg = 18,
  baseWide = false
): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, wSeg, hSeg);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    // Two profiles:
    //  - fur tuft (default): pinch only the upper hemisphere → round bulge
    //    at mid-height easing into the point (a fur clump).
    //  - baseWide (ears): pinch over the FULL height → widest at the domed
    //    base, tapering continuously to the soft tip (a soft ear wedge).
    const t = baseWide ? (y + 1) / 2 : Math.max(0, y);
    if (t > 0) {
      // Pinch strengthens toward the pole. Exponent 1.5 keeps the clump
      // FAT for most of its length and 0.86 leaves a rounded (not sharp)
      // tip — thin pointy locks read "spiky"; the sheet's fur is plush.
      const pinch = 1 - Math.pow(t, baseWide ? 1.6 : 1.5) * 0.86;
      pos.setX(i, pos.getX(i) * pinch);
      pos.setZ(i, pos.getZ(i) * pinch);
    }
  }
  geo.scale(r, h / 2, r);
  geo.translate(0, h / 2, 0);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Varying-radius tube along a planar spine — the tail's ONE-PIECE flame body.
 * A stack of overlapping spheres showed a rib line at every overlap (each
 * outline shell cut through its neighbour); this builds a single continuous
 * surface instead: rings of vertices perpendicular to the spine curve, radius
 * varying per ring, closed with rounded pole caps, smooth-shaded via
 * computeVertexNormals. One mesh → one clean silhouette → one outline shell.
 *
 * The spine lives in the local Y-Z plane ((y,z) pairs; X is the tube's
 * side-to-side axis, squashed by `xSquash` for a slim side profile).
 */
function flameTubeGeo(
  spine: Array<[number, number]>,
  radii: number[],
  radialSegs = 32,
  xSquash = 0.86,
  /** Optional per-vertex radial multiplier (tFrac 0..1 along spine, ring
   *  angle rad) — used to sculpt fur scallops INTO the surface. */
  bump?: (tFrac: number, ringAngle: number) => number,
  /** Pole-cap dome length as a fraction of the end radius. 0.95 = round
   *  cap; outline SHELL tubes pass ~0.1 (near-flat) — a domed shell cap
   *  bulges past its joint and pokes out of the neighbouring surface. */
  capScale = 0.95
): THREE.BufferGeometry {
  const n = spine.length;
  const positions: number[] = [];
  const indices: number[] = [];

  // Central-difference tangents along the spine
  const tangents: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(n - 1, i + 1)];
    const dy = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dy, dz) || 1;
    tangents.push([dy / l, dz / l]);
  }

  // Ring frame: e1 = +X (always ⊥ a Y-Z-plane tangent); e2 = (tz, -ty).
  for (let i = 0; i < n; i++) {
    const [sy, sz] = spine[i];
    const [ty, tz] = tangents[i];
    const e2y = tz;
    const e2z = -ty;
    for (let j = 0; j < radialSegs; j++) {
      const a = (j / radialSegs) * Math.PI * 2;
      const r = radii[i] * (bump ? bump(i / (n - 1), a) : 1);
      const cx = Math.cos(a) * r * xSquash;
      const s = Math.sin(a) * r;
      positions.push(cx, sy + e2y * s, sz + e2z * s);
    }
  }
  // Quad strip — winding verified against the render: (a,b,c)/(b,d,c) faces
  // OUTWARD with this frame (the first attempt with (a,c,b) showed the
  // outline shell's interior — the whole flame rendered outline-grey).
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const j2 = (j + 1) % radialSegs;
      const a = i * radialSegs + j;
      const b = i * radialSegs + j2;
      const c = (i + 1) * radialSegs + j;
      const d = (i + 1) * radialSegs + j2;
      indices.push(a, b, c, b, d, c);
    }
  }

  // Rounded pole caps — a single vertex pushed out along ∓tangent, fanned
  // to the first/last ring. Both caps end up buried (root inside the body,
  // end inside the tip fluff), so they only need to close the surface.
  const startPole = positions.length / 3;
  {
    const [sy, sz] = spine[0];
    const [ty, tz] = tangents[0];
    positions.push(0, sy - ty * radii[0] * capScale, sz - tz * radii[0] * capScale);
    for (let j = 0; j < radialSegs; j++) {
      const j2 = (j + 1) % radialSegs;
      indices.push(startPole, j2, j);
    }
  }
  const endPole = positions.length / 3;
  {
    const [sy, sz] = spine[n - 1];
    const [ty, tz] = tangents[n - 1];
    positions.push(0, sy + ty * radii[n - 1] * capScale, sz + tz * radii[n - 1] * capScale);
    const base = (n - 1) * radialSegs;
    for (let j = 0; j < radialSegs; j++) {
      const j2 = (j + 1) % radialSegs;
      indices.push(endPole, base + j, base + j2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export class VoxelCharacter {
  /** The logical root — attach physics / camera here. */
  public masterGroup: THREE.Group;

  /** The visual root — receives the snapped 8-way facing rotation. */
  private visualGroup: THREE.Group;

  // ── Hierarchical joints ────────────────────────────────────────────────────
  private torso:    THREE.Group;
  private head:     THREE.Group;
  private leftArm:  THREE.Group;
  private rightArm: THREE.Group;
  private leftLeg:  THREE.Group;
  private rightLeg: THREE.Group;
  private tail:     THREE.Group;

  // Ear groups tracked so we can twitch them subtly during idle
  private leftEar:  THREE.Group | null = null;
  private rightEar: THREE.Group | null = null;

  // Tail chain joints (built in _buildTail): the flame is split into three
  // chained sections — this.tail (root) → tailMid → tailTip — so sway can
  // travel down the plume with follow-through lag instead of waving one
  // rigid piece.
  private tailMid: THREE.Group | null = null;
  private tailTip: THREE.Group | null = null;

  // Torso "chest" group used for the subtle breathing scale
  private chest:    THREE.Group | null = null;

  /** Skull profile deformation, shared with the face patch so the drawn
   *  eyes keep hugging the sculpted (non-spherical) head front. Set in
   *  _buildHead before _buildFaceDecal runs. */
  private _sculptSkullProfile: ((geo: THREE.BufferGeometry) => void) | null = null;

  // ── Face + expression meshes (kept as refs for blink / smile lerp) ────────
  private leftEye:   THREE.Mesh | null = null;
  private rightEye:  THREE.Mesh | null = null;
  private mouth:     THREE.Mesh | null = null;
  private smileAmount = 0;

  // ── State ──────────────────────────────────────────────────────────────────
  private currentState: CharacterState = 'idle';

  /**
   * The continuous 0–2π logical facing angle (e.g. from network or input).
   * masterGroup.rotation.y always tracks this value exactly.
   */
  private logicalRotation = 0;

  private clock: THREE.Clock;

  // ── Outfit state (TR3, issue #35) ──────────────────────────────────────────
  /**
   * Pristine color/emissive per role-tagged material, captured lazily on the
   * FIRST setOutfit before anything is mutated. clearOutfit restores from
   * here, and setOutfit reads un-overridden roles from here — so repeated
   * applies are exact (absolute hexes, zero cumulative drift).
   */
  private outfitOriginals = new Map<
    THREE.MeshToonMaterial,
    { color: number; emissive: number; emissiveSeeded: boolean }
  >();
  /** Currently attached head accessory (one slot), or null. */
  private accessoryGroup: THREE.Group | null = null;

  constructor(scene: THREE.Scene) {
    // ── 1. Master / visual group hierarchy ───────────────────────────────────
    this.masterGroup = new THREE.Group();
    this.visualGroup = new THREE.Group();
    this.masterGroup.add(this.visualGroup);
    scene.add(this.masterGroup);

    // ── 2. Skeletal joints ────────────────────────────────────────────────────
    this.torso    = new THREE.Group();
    this.head     = new THREE.Group();
    this.leftArm  = new THREE.Group();
    this.rightArm = new THREE.Group();
    this.leftLeg  = new THREE.Group();
    this.rightLeg = new THREE.Group();
    this.tail     = new THREE.Group();

    // Build parent-child chain
    this.visualGroup.add(this.torso);
    this.torso.add(this.head);
    this.torso.add(this.leftArm);
    this.torso.add(this.rightArm);
    this.torso.add(this.leftLeg);
    this.torso.add(this.rightLeg);
    this.torso.add(this.tail);

    // ── 3. Pivot positions (chibi proportions) ───────────────────────────────
    // The joints stay in roughly the same world-Y positions so the walk
    // cycle / seat animations still land right, but the visual meshes attached
    // to each joint are re-sized so the head visually dominates and the limbs
    // read as short stubs.
    this.torso.position.y = 1.03;             // idle rootY (1.18) − 0.15 chibi offset — feet flush at spawn
    this.head.position.y  = 0.46;             // head sits ON the body (sheet has no neck — skull bottom overlaps the pear top by ~0.12)
    this.leftArm.position.set(-0.42, 0.26, 0);// shoulders — snug to the pear; paws must clear the belly (¾ views buried them at 0.40)
    this.rightArm.position.set( 0.42, 0.26, 0);
    this.leftLeg.position.set(-0.17, -0.30, 0); // hips — narrow stance; the sheet's feet nearly touch
    this.rightLeg.position.set( 0.17, -0.30, 0);

    // Tail root: attached LOW on the back (hip level) at the tail-bone.
    // rotation.x = -1.62 rad (≈ -93°) points the tail group's local +Y
    // straight BACK with a slight droop and maps local +Z to UP. The spine
    // in _buildTail dips along −Z then flicks up — the sheet's low-slung
    // brush. Side-set/sway happens on rotation.z (Euler XYZ applies Rz
    // first, i.e. in the pre-tilt frame, which yaws the whole brush around
    // world-up — rotation.y here would TWIST a drooped brush's plane).
    this.tail.position.set(0, -0.30, -0.28);
    this.tail.rotation.x = -1.62;

    // ── 4. Build voxel geometry ───────────────────────────────────────────────
    this._buildHead();
    this._buildTorso();
    this._buildArms();
    this._buildLegs();
    this._buildTail();

    this.clock = new THREE.Clock();
    console.log('✅ VoxelCharacter created (white reference-sheet fox)');
  }

  // ── Palette-role tagging (TR3, issue #35) ─────────────────────────────────
  //  Called at the end of each _build* with that builder's swappable
  //  materials. Tags every mesh under `root` whose material is one of them
  //  with userData.paletteRole so setOutfit can find the recolor targets.
  //  Everything else is skipped by construction: outline shells carry the
  //  shared OUTLINE_MAT, the face decal / nose / fang / grey ear-cavity
  //  cones use materials that simply aren't in the map.
  private _tagPaletteRoles(
    root: THREE.Object3D,
    roles: Array<[THREE.Material, PaletteRole]>
  ): void {
    const roleByMat = new Map(roles);
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const role = roleByMat.get(mesh.material);
      if (role) mesh.userData.paletteRole = role;
    });
  }

  // ── Head ─────────────────────────────────────────────────────────────────
  //  Reference sheet head: big round skull, FLAT cute face (barely-there
  //  muzzle bump), small charcoal nose, thin smile + one fang, huge ears
  //  with grey inner cavities, top-of-head tuft and spiky cheek ruffs.
  private _buildHead(): void {
    const furMat     = tmat(PAL.fur,        { emissiveBoost: 0.10 });
    const creamMat   = tmat(PAL.cream,      { emissiveBoost: 0.11 });  // muzzle zone (role 'cream')
    const shadeMat   = tmat(PAL.furShade,   { emissiveBoost: 0.08 });  // inner-ear cavity
    const shadeLoMat = tmat(PAL.furShadeLo, { emissiveBoost: 0.06 });  // deepest cavity accent
    const noseMat    = tmat(PAL.nose,       { emissiveBoost: 0.04 });
    const noseHiMat  = bmat(PAL.noseHi);
    const fangMat    = tmat(PAL.fang,       { emissiveBoost: 0.10 });

    // Skull — BIG rounded ball, a touch wider than tall (sheet's front
    // view). 64×44 segments: at play distance the silhouette must be a
    // perfect curve, no polygon flats.
    //
    // PROFILE SCULPT (sheet side view): the head is NOT a sphere from the
    // side — the face front (brow→jaw) is nearly VERTICAL, flattened, with
    // the nose riding proud of it, while the BACK of the skull bulges full
    // and round, overhanging the nape. One shared vertex op shapes the
    // skull AND the face patch so the drawn eyes keep hugging the surface.
    // Both curves are quadratic (C1 at their start planes — no shading
    // crease) and monotonic (no fold).
    const sculptSkullProfile = (geo: THREE.BufferGeometry): void => {
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        let z = p.getZ(i);
        if (z > 0.22) {
          // flatten the face front (front pole 0.61 → ≈0.47)
          z = z - (0.55 / 0.62) * Math.pow(z - 0.22, 2);
          // BROW-STOP: the sheet's profile has a tiny concave dip where
          // the forehead meets the nose bridge (a gaussian band at brow
          // height, front faces only)
          z -= 0.018 * Math.exp(-Math.pow((y - 0.50) / 0.10, 2));
        } else if (z < -0.15) {
          // fuller occiput (back pole -0.61 → ≈-0.68)
          z = z - (0.22 / 0.62) * Math.pow(z + 0.15, 2);
        }
        p.setZ(i, z);
        // CROWN FLATTEN: the sheet's front view tops the head with a
        // gentle flat between the ears, not a dome peak
        if (y > 0.45) {
          p.setY(i, y - (0.50 / 0.62) * Math.pow(y - 0.45, 2));
        }
        // CHEEK-LEVEL WIDTH: the head is WIDEST below the eye line (the
        // sheet's face is a soft rounded-square, fullest at the cheeks) —
        // a gaussian width band, max +5% at cheek height
        const band = Math.exp(-Math.pow((y - 0.10) / 0.22, 2));
        p.setX(i, x * (1 + 0.05 * band));
      }
      geo.computeVertexNormals();
    };

    const skullGeo = new THREE.SphereGeometry(0.62, 64, 44);
    skullGeo.scale(1.08, 1.00, 0.98);   // sheet head reads ~1.1× wider than tall
    sculptSkullProfile(skullGeo);
    skullGeo.translate(0, 0.42, 0);
    const skull = new THREE.Mesh(skullGeo, furMat);
    addWithOutline(this.head, skull, 0.028);
    // Face-patch geometry applies the same sculpt in _buildFaceDecal via
    // this hook (the patch is built later in this constructor pass).
    this._sculptSkullProfile = sculptSkullProfile;

    // Muzzle — the sheet's side view shows a compact rounded snout mass
    // low-center on the face: a central bump carrying the nose, a soft
    // cheek bulge either side of it, and a small chin below the mouth.
    // Sculpting it as four overlapping volumes (instead of one squashed
    // sphere) is what makes the lower face read 3D instead of flat.
    // SHEET RULE: the nose sits just under the eye line on the muzzle
    // mass, with the smile directly beneath it — the whole lower-face
    // cluster rides ~0.015 higher than the first sculpt.
    // No outline shell on the muzzle mass — the sheet's face has NO
    // boundary line around the muzzle; the nose/smile float on the face
    // with soft shading only (an outlined circle read as a snout patch).
    // The whole lower-face cluster rides the FLATTENED face plane (front
    // ≈0.47 after the profile sculpt) — the nose stays the foremost point
    // of the head like the sheet's side view, with the sheet's subtle
    // step-back from nose → mouth → receding chin.
    const muzzleGeo = new THREE.SphereGeometry(0.16, 36, 26);
    muzzleGeo.scale(1.15, 0.82, 0.80);
    const muzzle = new THREE.Mesh(muzzleGeo, creamMat);
    muzzle.position.set(0, 0.29, 0.455);
    this.head.add(muzzle);

    const cheekGeo = new THREE.SphereGeometry(0.105, 28, 20);
    cheekGeo.scale(1.20, 0.85, 0.72);
    for (const cs of [-1, 1] as const) {
      const cheekBulge = new THREE.Mesh(cheekGeo, creamMat);
      cheekBulge.position.set(cs * 0.135, 0.265, 0.435);
      this.head.add(cheekBulge);   // no outline — blends into the muzzle mass
    }

    const chinGeo = new THREE.SphereGeometry(0.062, 22, 16);
    chinGeo.scale(1.25, 0.70, 0.85);
    const chin = new THREE.Mesh(chinGeo, creamMat);
    chin.position.set(0, 0.115, 0.465);
    this.head.add(chin);

    // Nose — small charcoal rounded-triangle read (squashed sphere)
    const noseGeo = new THREE.SphereGeometry(0.055, 26, 20);
    noseGeo.scale(1.30, 0.85, 0.80);
    const nose = new THREE.Mesh(noseGeo, noseMat);
    nose.position.set(0, 0.33, 0.575);
    addWithOutline(this.head, nose, 0.030);
    // Nose highlight speck — unlit, tiny
    const noseHi = new THREE.Mesh(
      new THREE.SphereGeometry(0.016, 14, 12),
      noseHiMat
    );
    noseHi.position.set(-0.012, 0.35, 0.612);
    this.head.add(noseHi);

    // Mouth — thin charcoal SMILE ARC (torus segment facing +Z), not a box.
    // Arc spans 0.8π centred on the bottom of its circle so it reads as the
    // sheet's gentle upturned smile; _updateFaceRig widens scale.x on walk.
    const mouthGeo = new THREE.TorusGeometry(0.075, 0.012, 12, 32, Math.PI * 0.8);
    mouthGeo.rotateZ(-Math.PI * 0.9);   // centre the arc about local -Y (smile)
    const mouth = new THREE.Mesh(mouthGeo, noseMat);
    mouth.position.set(0, 0.215, 0.572);
    this.head.add(mouth);
    this.mouth = mouth;

    // Tiny fang — the sheet's ¾ and face views show ONE small tooth peeking
    // from the smile (viewer-left of centre). A soft teardrop, not a hard
    // cone, so the tooth reads rounded like the sheet. Separate from the
    // mouth mesh so the smile-widening scale doesn't stretch it.
    const fangGeo = fluffGeo(0.018, 0.052, 14, 12);
    fangGeo.rotateX(Math.PI);           // point DOWN (base at the gum line)
    const fang = new THREE.Mesh(fangGeo, fangMat);
    fang.position.set(-0.055, 0.165, 0.577);   // hangs from the smile arc
    this.head.add(fang);

    // ── FACE DECAL (canvas-drawn 2D eyes + brows) ────────────────────────
    // The eyes and eyebrows are painted onto a canvas texture on a flat
    // plane in front of the head (the cute-mascot approach — 2D-drawn face
    // on a 3D body). This sidesteps every Z-fighting and visibility issue a
    // stack of eye spheres would bring, and each face dimension is a single
    // number in _buildFaceDecal. The nose / smile arc / fang stay 3D above
    // because they ride the muzzle bump's curvature.
    const facePlane = this._buildFaceDecal();
    this.head.add(facePlane);
    (facePlane as any).__leftEye = facePlane;   // reused by blink lerp
    this.leftEye  = facePlane;
    this.rightEye = facePlane;
    // The smile-arc mesh built above is the smile-anchor (this.mouth).

    // ── Ears ─────────────────────────────────────────────────────────────
    // The sheet's dominant feature: HUGE wide-flared ears, nearly as tall
    // as the head ball, white outside with a grey inner cavity (and a
    // deeper grey core for depth), plus fluff wisps at the cavity base. No
    // dark tips — white to the point. Built from exact 2D outlines
    // (ExtrudeGeometry with bevelled rims) because the sheet's silhouette
    // is asymmetric — near-vertical inner edge, long concave outer flare —
    // which no symmetric cone/teardrop can express.
    //
    // Anti-"floating triangle" rule carried over from the previous pass:
    // the ear group origin sits inside the skull surface and the outline's
    // base curve dips below y=0, so the slab embeds seamlessly — no gap,
    // no visible seam.
    const buildEar = (side: -1 | 1) => {
      const g = new THREE.Group();

      // The sheet's ear silhouette is ASYMMETRIC: a wide base whose inner
      // edge rises near-vertical from close to the head's centreline, while
      // the OUTER edge is one long concave flare sweeping up to a soft tip
      // that points up-and-slightly-out. A symmetric cone/teardrop can't
      // produce that, so each ear layer is drawn as an exact 2D outline
      // (+x = toward the ear's outer side) and extruded with generous
      // bevels for the soft slab rim. `s` mirrors the outline per side.
      // SHEET RULE: the two ears must NOT touch at the middle of the head —
      // their inner base edges stop ~0.12 either side of the centreline
      // (the head tuft fills the gap). Inner bound here is -0.18 in ear
      // space; with the group at ±0.30 the inner edge lands at ±0.12.
      // SHEET RULE: the ear's BASE LINE SLOPES DOWN THE DOME — the inner
      // base corner sits high near the crown while the outer corner rides
      // low, meeting the head's silhouette edge. A level base left the
      // outer side hovering in air beside the skull ("floating ears").
      const s = side;
      const outerShape = new THREE.Shape();
      outerShape.moveTo(-0.18 * s, 0.06);
      // inner edge — near vertical, slight outward lean toward the tip
      outerShape.quadraticCurveTo(-0.20 * s, 0.55, -0.03 * s, 0.93);
      // POINTED tip (tiny rounding only — a domed tip reads rabbit, not fox)
      outerShape.quadraticCurveTo(0.03 * s, 1.00, 0.07 * s, 0.90);
      // outer edge — long concave flare down to the LOW outer base corner
      outerShape.quadraticCurveTo(0.26 * s, 0.44, 0.36 * s, -0.10);
      // diagonal base sweep back up to the inner corner, dipping below the
      // dome line so the whole foot embeds in the skull
      outerShape.quadraticCurveTo(0.04 * s, -0.34, -0.18 * s, 0.06);

      const outerGeo = new THREE.ExtrudeGeometry(outerShape, {
        depth: 0.10,
        bevelEnabled: true,
        bevelThickness: 0.05,
        bevelSize: 0.04,
        bevelSegments: 5,
        curveSegments: 28,
      });
      outerGeo.translate(0, 0, -0.05);   // centre the slab front-to-back

      // WEDGE taper + DOME CUP — a uniform flat extrusion reads as a board
      // edge-on and its side edges stand off the skull's front-back curve.
      // Per vertex: (1) depth scales down with height (thin toward the
      // tip, like the sheet's side view); (2) a parabolic x² cup pulls the
      // lateral edges backward so the ear hugs the dome (and gives the
      // natural cupped-forward ear look); optional `pull` shifts the
      // cavity panels back to follow the shrinking front face.
      const taperEar = (
        geo: THREE.BufferGeometry,
        h: number,
        pull = 0
      ): void => {
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const yy = Math.max(0, pos.getY(i));
          const xx = pos.getX(i);
          const f = 1 - 0.68 * Math.min(1, yy / h);
          const cup = (xx * xx) / 2.0;
          pos.setZ(i, (pos.getZ(i) - cup) * f - pull * Math.min(1, yy / h));
        }
        geo.computeVertexNormals();
      };
      taperEar(outerGeo, 1.0);
      const outer = new THREE.Mesh(outerGeo, furMat);
      addWithOutline(g, outer, 0.024);

      // Inner cavity — inset copy of the outline, thin extrusion floating
      // just in front of the outer slab (the sheet shades the whole inner
      // triangle with a clear rim of white around it).
      const cavShape = new THREE.Shape();
      cavShape.moveTo(-0.090 * s, 0.16);
      cavShape.quadraticCurveTo(-0.100 * s, 0.52, 0.000, 0.80);
      cavShape.quadraticCurveTo(0.030 * s, 0.85, 0.060 * s, 0.77);
      cavShape.quadraticCurveTo(0.180 * s, 0.42, 0.240 * s, 0.02);
      cavShape.quadraticCurveTo(0.040 * s, -0.02, -0.090 * s, 0.16);
      const cavGeo = new THREE.ExtrudeGeometry(cavShape, {
        depth: 0.02,
        bevelEnabled: true,
        bevelThickness: 0.02,
        bevelSize: 0.02,
        bevelSegments: 4,
        curveSegments: 24,
      });
      taperEar(cavGeo, 0.85, 0.075);   // follow the wedge's receding front
      const cavity = new THREE.Mesh(cavGeo, shadeMat);
      cavity.position.set(0, 0.04, 0.115);   // lifted — its base edge peeked
      g.add(cavity);                         // past the outer slab's base dip

      // Deepest cavity accent — smaller inset, deeper grey
      const coreShape = new THREE.Shape();
      coreShape.moveTo(-0.030 * s, 0.24);
      coreShape.quadraticCurveTo(-0.035 * s, 0.46, 0.010 * s, 0.64);
      coreShape.quadraticCurveTo(0.035 * s, 0.68, 0.055 * s, 0.62);
      coreShape.quadraticCurveTo(0.105 * s, 0.40, 0.130 * s, 0.14);
      coreShape.quadraticCurveTo(0.040 * s, 0.10, -0.030 * s, 0.24);
      const coreGeo = new THREE.ExtrudeGeometry(coreShape, {
        depth: 0.015,
        bevelEnabled: true,
        bevelThickness: 0.015,
        bevelSize: 0.015,
        bevelSegments: 3,
        curveSegments: 20,
      });
      taperEar(coreGeo, 0.68, 0.085);   // follow the wedge's receding front
      const core = new THREE.Mesh(coreGeo, shadeLoMat);
      core.position.set(0, 0.04, 0.135);
      g.add(core);

      // Ear-base fluff wisps — three tiny white tufts overlapping the
      // cavity base (the sheet tucks head-fur locks into each ear opening)
      const wA = new THREE.Mesh(fluffGeo(0.040, 0.15, 16, 12), furMat);
      const wB = new THREE.Mesh(fluffGeo(0.034, 0.12, 16, 12), furMat);
      const wC = new THREE.Mesh(fluffGeo(0.040, 0.15, 16, 12), furMat);
      // Raised to overlap the cavity panel's lower bevel edge (its grey
      // side face showed as small dashes from the front)
      wA.position.set(-0.07 * s, 0.11, 0.15); wA.rotation.z =  0.30 * s;
      wB.position.set( 0.01 * s, 0.09, 0.16);
      wC.position.set( 0.09 * s, 0.12, 0.15); wC.rotation.z = -0.30 * s;
      g.add(wA, wB, wC);

      // Inner-ear fold — the sheet draws a soft vertical ridge along the
      // cavity's inner edge; a flattened white lock leaning up the inner
      // side gives that fold in 3D.
      const foldGeo = fluffGeo(0.05, 0.32, 16, 14);
      foldGeo.scale(1.0, 1.0, 0.5);
      foldGeo.computeVertexNormals();
      const fold = new THREE.Mesh(foldGeo, furMat);
      fold.position.set(-0.13 * s, 0.16, 0.13);
      fold.rotation.z = 0.14 * s;
      g.add(fold);

      // Base sunk INTO the skull dome and tilted outward so the wide outer
      // corner tucks along the head's curve instead of hovering over it.
      // At ±0.30 the inner base edges clear the centreline by 0.12 each —
      // the sheet's ears never touch in the middle. Group-level y-squash
      // sets the final ear height (owner call: less tall than the drawn
      // 1.0 ear-space unit) without redrawing the outlines.
      // z -0.10: the sheet's side view seats the ears on the BACK HALF of
      // the crown, not centred over it.
      g.position.set(side * 0.30, 0.82, -0.10);
      g.rotation.z = side * -0.16;
      g.rotation.x = -0.10;
      g.scale.y = 0.82;
      return g;
    };
    this.leftEar  = buildEar(-1);
    this.rightEar = buildEar( 1);
    this.head.add(this.leftEar, this.rightEar);

    // ── Head tuft ────────────────────────────────────────────────────────
    // Small fur tuft on top of the skull between the ears, leaning forward
    // — three soft fluff teardrops with their round bases pinned at the
    // mesh position so rotations splay them like real fur clumps.
    // All locks sweep the SAME direction (rotZ ≥ 0) — the sheet's tuft
    // flops to one side as a single combed clump, not a symmetric splay —
    // and hangs OVER THE FOREHEAD (side view: the flop breaks the crown
    // line at the FRONT, bangs-like), hence the forward z shift + lean.
    const tuftSpec: Array<[number, number, number, number, number, number, number]> = [
      // x      y     z     r      h     rotX   rotZ   (fat plush clumps)
      [ 0.00, 0.98, 0.18, 0.115, 0.32, -0.85,  0.10],
      [-0.11, 0.97, 0.14, 0.090, 0.25, -0.75,  0.35],
      [ 0.09, 0.98, 0.15, 0.085, 0.21, -0.70, -0.05],
      [-0.04, 0.99, 0.20, 0.070, 0.17, -0.95,  0.22],
    ];
    for (const [x, y, z, r, h, rx, rz] of tuftSpec) {
      const spike = new THREE.Mesh(fluffGeo(r, h, 20, 16), furMat);
      spike.position.set(x, y, z);
      spike.rotation.set(rx, 0, rz);
      addWithOutline(this.head, spike, 0.020);
    }

    // ── Cheek ruffs ──────────────────────────────────────────────────────
    // Fluffy fur on both sides of the lower head (sheet front view). Three
    // soft teardrops per side pointing outward-and-down, bases pinned just
    // inside the skull surface.
    for (const side of [-1, 1] as const) {
      // The sheet's cheek fan projects near-HORIZONTALLY at eye level
      // (middle lock longest); drooping tilts read as jowls, not fluff.
      const ruffSpec: Array<[number, number, number, number, number]> = [
        // y      z     r      h     tilt past horizontal (fat clumps)
        [ 0.43, 0.04, 0.085, 0.20, -0.10],
        [ 0.31, 0.08, 0.125, 0.34,  0.10],
        [ 0.20, 0.12, 0.100, 0.25,  0.42],
      ];
      for (const [y, z, r, h, tilt] of ruffSpec) {
        const spike = new THREE.Mesh(fluffGeo(r, h, 20, 16), furMat);
        // Base just inside the skull surface at that height
        spike.position.set(side * 0.52, y, z);
        // Point the teardrop's +Y outward-and-down past horizontal
        spike.rotation.z = -side * (Math.PI / 2 + tilt);
        addWithOutline(this.head, spike, 0.020);
      }

      // Jaw lock — the sheet's PROFILE shows one fur lock breaking the
      // lower-cheek line toward the back of the jaw; aimed out-down-back.
      // No outline (barely-embedded fluff shells halo — see rump note).
      const jaw = new THREE.Mesh(fluffGeo(0.075, 0.20, 18, 14), furMat);
      jaw.position.set(side * 0.40, 0.16, -0.10);
      jaw.rotation.set(-2.6, 0, -side * 0.55);
      this.head.add(jaw);
    }

    // Outfit roles: skull / ears / tufts / ruffs = fur; muzzle zone = cream;
    // BOTH grey ear-cavity cones = furDeep (keeps the furDeep outfit slot
    // meaningful now that the fox-marking ear-backs/tail-mid are gone — an
    // outfit override unifies the cavity two-tone, clearOutfit restores it).
    // Nose, fang and the face decal stay untagged.
    this._tagPaletteRoles(this.head, [
      [furMat, 'fur'],
      [creamMat, 'cream'],
      [shadeMat, 'furDeep'],
      [shadeLoMat, 'furDeep'],
    ]);
  }

  // ── Face decal ──────────────────────────────────────────────────────────
  //  Canvas-drawn reference-sheet face (dark glossy eyes + thin brows) on a
  //  plane in front of the head. The plane is transparent everywhere except
  //  the drawn strokes, so the white fur shows through around them. The
  //  plane sits just in front of the skull surface at y = 0.42
  //  (upper-middle of face); the 3D nose / smile / fang occupy the lower
  //  face on the muzzle bump.
  //
  //  Why canvas 2D instead of stacking THREE meshes: we get clean crisp
  //  strokes that read at any camera distance, and every dimension is a
  //  single number here instead of three variables per THREE.Sphere.
  private _buildFaceDecal(): THREE.Mesh {
    // 1024px backing canvas drawn in 512-space via a 2× transform — crisp
    // eye edges at close zoom without touching any drawing coordinates.
    const SIZE = 512;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE * 2;
    canvas.height = SIZE * 2;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(2, 2);

    // Transparent background — the head fur shows through everywhere the
    // face isn't drawn.
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Reference-sheet face: the eyes are DARK GLOSSY OVALS (no cream sclera,
    // no teal iris) with big white highlights, and thin brow strokes float
    // above them. Charcoal tones, never pure black — matches PAL.nose.
    const EYE      = '#35333a';
    const EYE_SOFT = '#4a4852';   // subtle lighter lower-inner sheen
    const SHINE    = '#ffffff';
    const BROW     = '#3a383f';

    // ── Eyes ─── two mirrored dark glossy ovals ──────────────────────
    // Face coord system: (0,0) = top-left of canvas, (256, 256) = center.
    // Positioned in the upper-middle so the muzzle/mouth 3D geometry
    // occupies the lower face.
    const drawEye = (cx: number, cy: number, side: -1 | 1) => {
      // Eye body — tall dark oval
      ctx.fillStyle = EYE;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 68, 92, 0, 0, Math.PI * 2);
      ctx.fill();

      // Soft lower sheen — slightly lighter oval sunk toward the bottom,
      // sells the "wet glossy" ball read from the sheet.
      ctx.fillStyle = EYE_SOFT;
      ctx.beginPath();
      ctx.ellipse(cx, cy + 26, 46, 54, 0, 0, Math.PI * 2);
      ctx.fill();

      // Big shine — white oval, upper-left on BOTH eyes (single light
      // source, exactly like the sheet).
      ctx.fillStyle = SHINE;
      ctx.beginPath();
      ctx.ellipse(cx - 22, cy - 34, 20, 26, 0, 0, Math.PI * 2);
      ctx.fill();

      // Small secondary shine — lower-right dot
      ctx.beginPath();
      ctx.ellipse(cx + 18, cy + 36, 9, 11, 0, 0, Math.PI * 2);
      ctx.fill();

      // Thin eyebrow stroke — short gentle arc close above the eye,
      // slightly higher at the inner end (the sheet's soft neutral brow;
      // brows floating too high read "surprised").
      ctx.strokeStyle = BROW;
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - side * 40, cy - 104);
      ctx.quadraticCurveTo(cx, cy - 120, cx + side * 34, cy - 100);
      ctx.stroke();
    };
    // Two eyes with a WIDE nose-bridge gap — the sheet spaces the eyes
    // about half an eye-width apart, and centres them slightly BELOW the
    // head ball's midline (238 in canvas space lands there).
    drawEye(158, 238, -1);
    drawEye(354, 238,  1);

    // Build the texture and plane. The plane is sized 0.90 units wide so
    // the drawn eyes end up ~0.24 wide each in world space — the big dark
    // glossy read the reference sheet leads with.
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 8;
    // NOTE: keep default sRGB in three.js r167 (no explicit colorSpace set
    // here — the canvas is already sRGB and the renderer knows).

    // CURVED patch, not a flat plane: a section of a sphere a hair larger
    // than the skull, so the face hugs the head at every viewing angle (a
    // flat plane showed as a floating sliver at profile). Angular ranges
    // solved so the drawn eyes land at the same world height/spacing the
    // flat 0.90-unit plane used: φ spans 1.40 rad centred on +Z, θ spans
    // 0.82–2.32 rad (brow line → under-chin, the empty bottom is discarded
    // by alphaTest).
    const geo = new THREE.SphereGeometry(0.62, 48, 36, 0.871, 1.40, 0.82, 1.50);
    geo.scale(1.089, 1.008, 0.988);   // skull scale (1.08,1.0,0.98) × ~1.008 proud
                                      // (tighter = smaller dark sliver at profile)
    // Follow the skull's flattened-face profile sculpt so the eyes stay on
    // the surface (identical op on a ~0.8%-larger sphere ⇒ stays ~0.8%
    // proud everywhere for this gentle deformation).
    if (this._sculptSkullProfile) this._sculptSkullProfile(geo);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.02,       // treat near-transparent pixels as fully clear
      side: THREE.FrontSide, // back views cull the patch (skull occludes it)
      depthWrite: false,     // don't mask surrounding fur through the patch
    });
    const patch = new THREE.Mesh(geo, mat);
    // Same origin as the skull sphere; blink's scale.y squash pulls the
    // drawn eyes down toward the skull centre-line like closing lids.
    patch.position.set(0, 0.42, 0);
    // Render after the skull so alpha compositing works cleanly.
    patch.renderOrder = 5;
    return patch;
  }

  // ── Torso ────────────────────────────────────────────────────────────────
  //  Reference sheet body: PEAR-shaped — narrow sloped shoulders widening to
  //  a round belly — with a spiky chest-bib tuft under the chin. One lathe
  //  profile gives a single smooth silhouette (one outline shell, no seam
  //  where separate chest/belly spheres would overlap).
  private _buildTorso(): void {
    const furMat   = tmat(PAL.fur,   { emissiveBoost: 0.09 });
    const creamMat = tmat(PAL.cream, { emissiveBoost: 0.11 });

    this.chest = new THREE.Group();
    this.torso.add(this.chest);

    // Pear profile, bottom → top (lathe revolves around Y). Control points
    // are smoothed through a Catmull-Rom spline (36 samples × 48 radial
    // segments) so the silhouette is one continuous curve — the widest
    // point sits at lower-belly height; front-back flattened 18% so the
    // body isn't a perfect ball from the side (sheet side view).
    // Bottom two points make the sheet's belly-to-crotch S-tuck (the
    // underside curls in before meeting the legs, not a flat cap).
    const pearCtrl: THREE.Vector2[] = [
      new THREE.Vector2(0.000, -0.445),
      new THREE.Vector2(0.130, -0.425),
      new THREE.Vector2(0.240, -0.38),
      new THREE.Vector2(0.400, -0.24),
      new THREE.Vector2(0.455, -0.06),
      new THREE.Vector2(0.430,  0.10),
      new THREE.Vector2(0.345,  0.24),
      new THREE.Vector2(0.240,  0.33),
      new THREE.Vector2(0.000,  0.38),
    ];
    const pearPts = new THREE.SplineCurve(pearCtrl).getPoints(36);
    const torsoGeo = new THREE.LatheGeometry(pearPts, 48);
    torsoGeo.scale(1.0, 1.0, 0.82);
    // BELLY-FORWARD ASYMMETRY + BACK-S (sheet side view): the belly bows
    // clearly forward (+6% depth) while the back is NOT one flat line —
    // it's an S: flat across the shoulder-blades (−13%), easing into a
    // RUMP BULGE below the waist (−3%) before the tail. The front/back
    // factors blend through a smoothstep band across z=0 so the side seam
    // is C1 (a hard two-branch scale left a derivative kink — audit note).
    {
      const tp = torsoGeo.attributes.position;
      for (let i = 0; i < tp.count; i++) {
        const y = tp.getY(i);
        const z = tp.getZ(i);
        const rump = Math.min(1, Math.max(0, (-y - 0.05) / 0.25));
        const backF = 0.87 + 0.10 * rump;
        const s = Math.min(1, Math.max(0, (z + 0.06) / 0.12));
        const blend = s * s * (3 - 2 * s);
        tp.setZ(i, z * (backF + (1.06 - backF) * blend));
      }
      torsoGeo.computeVertexNormals();
    }
    const torso = new THREE.Mesh(torsoGeo, furMat);
    addWithOutline(this.chest, torso, 0.024);

    // Chest bib — the sheet's fluffy fur tuft below the chin: a soft mound
    // plus a fan of downward-pointing fluff teardrops across the upper
    // chest. Cream role (white for now) so outfits can still dye the bib.
    const bibGeo = new THREE.SphereGeometry(0.25, 32, 24);
    bibGeo.scale(1.10, 0.62, 0.75);
    const bib = new THREE.Mesh(bibGeo, creamMat);
    bib.position.set(0, 0.30, 0.14);   // snug against the chest, not floating
    addWithOutline(this.chest, bib, 0.022);

    // A tight fan hanging off the mound — the sheet's tuft is one fluffy
    // triangular MASS, so the teardrops overlap instead of ringing like a
    // necklace.
    const bibSpikes: Array<[number, number, number, number, number, number]> = [
      // x      y     z     r      h     rotZ (splay) — fat plush clumps
      [ 0.00, 0.32, 0.24, 0.120, 0.34,  0.00],
      [-0.09, 0.33, 0.22, 0.095, 0.27,  0.16],
      [ 0.09, 0.33, 0.22, 0.095, 0.27, -0.16],
      [-0.17, 0.34, 0.19, 0.075, 0.19,  0.32],
      [ 0.17, 0.34, 0.19, 0.075, 0.19, -0.32],
    ];
    for (const [x, y, z, r, h, rz] of bibSpikes) {
      const spike = new THREE.Mesh(fluffGeo(r, h, 20, 16), creamMat);
      spike.position.set(x, y, z);
      // Point DOWN-and-forward with a per-spike sideways splay
      spike.rotation.set(Math.PI * 0.88, 0, rz);
      addWithOutline(this.chest, spike, 0.020);
    }

    // Second (upper) bib row — the sheet layers the chest tuft in TWO
    // rows: a short row of locks tucked right under the chin overlapping
    // the big fan. No shells (halo rule).
    const bibRow2: Array<[number, number, number, number, number, number]> = [
      // x      y     z     r      h     rotZ
      [ 0.00, 0.40, 0.20, 0.072, 0.18,  0.00],
      [-0.10, 0.41, 0.18, 0.058, 0.14,  0.20],
      [ 0.10, 0.41, 0.18, 0.058, 0.14, -0.20],
    ];
    for (const [x, y, z, r, h, rz] of bibRow2) {
      const lock = new THREE.Mesh(fluffGeo(r, h, 18, 14), creamMat);
      lock.position.set(x, y, z);
      lock.rotation.set(Math.PI * 0.86, 0, rz);
      this.chest.add(lock);
    }

    // Rump fluff — the sheet's back view shows a fur burst where the tail
    // meets the body; three locks draping down over the tail root.
    const rumpSpec: Array<[number, number, number, number, number, number]> = [
      // x      y      z      r      h     rotZ splay — fat plush clumps
      [ 0.00, -0.16, -0.30, 0.088, 0.21,  0.00],
      [-0.10, -0.14, -0.28, 0.070, 0.16,  0.28],
      [ 0.10, -0.14, -0.28, 0.070, 0.16, -0.28],
    ];
    for (const [x, y, z, r, h, rz] of rumpSpec) {
      const lock = new THREE.Mesh(fluffGeo(r, h, 18, 14), furMat);
      lock.position.set(x, y, z);
      // Drape DOWN-and-back over the tail root. NO outline shells: a shell
      // on a barely-embedded fluff draws a grey halo leaf around its
      // insertion — this was the persistent "grey patch at the tail" that
      // was misread as a tail-tube artifact three fixes running.
      lock.rotation.set(-Math.PI * 0.82, 0, rz);
      this.chest.add(lock);
    }

    // Hip tufts — small locks flicking down-and-out where the belly meets
    // the legs (subtle silhouette breaks the sheet shows at the hips).
    for (const hs of [-1, 1] as const) {
      const hip = new THREE.Mesh(fluffGeo(0.070, 0.16, 18, 14), furMat);
      hip.position.set(hs * 0.40, -0.24, 0.02);
      hip.rotation.z = -hs * 2.5;   // tip points down-and-out
      this.chest.add(hip);          // no shell — halo risk (see rump note)
    }

    // Nape ruff — the sheet's BACK view shows a fur collar where the head
    // meets the shoulders: three locks draping down over the shoulder
    // blades (the bib's counterpart around the back).
    const napeSpec: Array<[number, number, number, number, number, number]> = [
      // x      y     z      r      h     rotZ splay
      [ 0.00, 0.32, -0.24, 0.085, 0.22,  0.00],
      [-0.12, 0.31, -0.22, 0.070, 0.18,  0.25],
      [ 0.12, 0.31, -0.22, 0.070, 0.18, -0.25],
    ];
    for (const [x, y, z, r, h, rz] of napeSpec) {
      const lock = new THREE.Mesh(fluffGeo(r, h, 18, 14), furMat);
      lock.position.set(x, y, z);
      // Drape DOWN-and-back over the shoulder blades
      lock.rotation.set(-2.55, 0, rz);
      this.chest.add(lock);         // no shell — halo risk (see rump note)
    }

    // Outfit roles: torso shell = fur; chest bib + spikes = cream.
    this._tagPaletteRoles(this.chest, [
      [furMat, 'fur'],
      [creamMat, 'cream'],
    ]);
  }

  // ── Arms ─────────────────────────────────────────────────────────────────
  //  Reference sheet arms: short white stubs hanging with a slight OUTWARD
  //  curve, ending in rounded mitten paws a touch fatter than the wrist.
  //  No gloves, no pads — the sheet shows plain white mittens.
  private _buildArms(): void {
    const furMat = tmat(PAL.fur, { emissiveBoost: 0.09 });
    const pawMat = tmat(PAL.paw, { emissiveBoost: 0.09 });

    const buildArm = (group: THREE.Group, side: -1 | 1) => {
      // Arm — a BENT varying-radius tube, not a straight cylinder: the
      // sheet's arms bow gently OUTWARD at the elbow and return inline at
      // the wrist (a true S against the body). Built with the tail's tube
      // helper: spine along +Y with the bow in the z-slot, flipped down
      // (rotateZ π keeps the proven outward winding) and the bow rotated
      // to point outward (rotateY ±90°). Tapers 0.135 → 0.112.
      const ARM_RINGS = 12;
      const armSpine: Array<[number, number]> = [];
      const armRadii: number[] = [];
      for (let i = 0; i < ARM_RINGS; i++) {
        const t = i / (ARM_RINGS - 1);
        armSpine.push([0.42 * t, 0.038 * Math.sin(Math.PI * t)]);
        armRadii.push(0.135 - 0.023 * t);
      }
      const armGeo = flameTubeGeo(armSpine, armRadii, 24, 1.0, undefined, 0.6);
      armGeo.rotateZ(Math.PI);                 // +Y spine → hangs down -Y
      armGeo.rotateY(side * Math.PI * 0.5);    // elbow bow → outward ±X
      const arm = new THREE.Mesh(armGeo, furMat);
      addWithOutline(group, arm, 0.024);
      const shoulderGeo = new THREE.SphereGeometry(0.135, 24, 18);
      const shoulder = new THREE.Mesh(shoulderGeo, furMat);
      shoulder.position.y = -0.02;
      group.add(shoulder);

      // Mitten paw — a sculpted SCOOP, not a plain ball: narrower at the
      // wrist, bulging wider and deeper toward the fingertips like the
      // sheet's bean-shaped mittens, with three subtle finger mounds
      // whose shells draw the sheet's faint hand-cleft lines. Offset a
      // touch toward the body + forward for the arm's S. getPawWorldPos
      // keeps the plain (0,-0.47,0) anchor — offsets are inside the
      // drink-hold tolerance.
      const pawG = new THREE.Group();
      pawG.position.set(side * -0.022, -0.47, 0.012);
      group.add(pawG);

      const pawGeo = new THREE.SphereGeometry(0.135, 32, 24);
      pawGeo.scale(1.0, 1.08, 1.0);
      {
        const pp = pawGeo.attributes.position;
        for (let i = 0; i < pp.count; i++) {
          const tipness = Math.min(1, Math.max(0, -pp.getY(i) / 0.146));
          pp.setX(i, pp.getX(i) * (1 + 0.12 * tipness));
          pp.setZ(i, pp.getZ(i) * (1 + 0.10 * tipness));
        }
        pawGeo.computeVertexNormals();
      }
      const paw = new THREE.Mesh(pawGeo, pawMat);
      addWithOutline(pawG, paw, 0.026);

      // Hand CLEFTS — same rule as the feet: the sheet's mitten fingers
      // are faint slice LINES on the lower front of the paw, not bump
      // volumes. Two short thin strokes, half-buried.
      const handCleftMat = bmat(PAL.outline);
      for (const cx of [-0.028, 0.028]) {
        const cleftGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.055, 8);
        const cleft = new THREE.Mesh(cleftGeo, handCleftMat);
        cleft.position.set(cx, -0.118, 0.062);
        cleft.rotation.x = 0.45;   // mostly vertical, following the
        pawG.add(cleft);           // mitten's lower-front curve
      }

      // Outward hang (sheet front view): reduced to 0.10 — the tube's
      // built-in elbow bow now supplies most of the outward read, and the
      // wrist returns inline so the paws sit against the belly like the
      // sheet. update() only animates rotation.x, so this persists.
      group.rotation.z = side * 0.10;
    };

    buildArm(this.leftArm, -1);
    buildArm(this.rightArm, 1);

    // Outfit roles: arm = fur; mitten paw = accent (reads as "gloves" when
    // an outfit dyes the accent slot).
    for (const arm of [this.leftArm, this.rightArm]) {
      this._tagPaletteRoles(arm, [
        [furMat, 'fur'],
        [pawMat, 'accent'],
      ]);
    }
  }

  // ── Legs ─────────────────────────────────────────────────────────────────
  //  Reference sheet legs: VERY short white stubs into rounded feet with a
  //  three-toe front (the toe clefts read via the outline shells between the
  //  toe balls). No socks, no pads — plain white.
  //
  //  Floor-flush constraint (issue #21 / rootY table): the lowest geometry
  //  must reach y ≈ -0.733 below the leg pivot so idle rootY 1.18 keeps the
  //  soles flush with the y=0 floor. Foot ball: -0.62 - 0.155·0.73 = -0.733.
  private _buildLegs(): void {
    const furMat = tmat(PAL.fur, { emissiveBoost: 0.09 });
    const pawMat = tmat(PAL.paw, { emissiveBoost: 0.09 });

    const buildLeg = (group: THREE.Group, side: -1 | 1) => {
      // Stub leg — short white cylinder from hip toward the foot, domed at
      // the hip so no flat disc shows against the torso. Stronger taper
      // (0.175 → 0.135): the sheet's legs narrow clearly at the ankle
      // before the foot flares.
      const legGeo = new THREE.CylinderGeometry(0.175, 0.135, 0.34, 28);
      legGeo.translate(0, -0.30, 0);
      const leg = new THREE.Mesh(legGeo, furMat);
      addWithOutline(group, leg, 0.024);
      const hipGeo = new THREE.SphereGeometry(0.17, 24, 18);
      const hip = new THREE.Mesh(hipGeo, furMat);
      hip.position.y = -0.14;
      group.add(hip);

      // Foot assembly — its own sub-group so the whole foot (loaf + toes)
      // angles slightly OUTWARD like the sheet's toe direction.
      const footG = new THREE.Group();
      footG.position.set(0, -0.62, 0.04);
      footG.rotation.y = side * 0.09;
      group.add(footG);

      // Foot loaf — SCULPTED, not a plain ellipsoid: tall round heel and
      // ankle SLOPING DOWN and WIDENING toward the toes (the sheet's
      // wedge-with-round-curves side profile). Heel keeps the floor-flush
      // bottom (-0.733 leg-local); the toe zone rises a hair off the
      // ground the way the sheet draws it.
      const footGeo = new THREE.SphereGeometry(0.155, 32, 22);
      footGeo.scale(1.30, 0.73, 1.42);
      {
        const fp = footGeo.attributes.position;
        for (let i = 0; i < fp.count; i++) {
          const frontness = Math.min(1, Math.max(0, fp.getZ(i) / 0.22));
          fp.setY(i, fp.getY(i) * (1 - 0.20 * frontness) - 0.012 * frontness);
          fp.setX(i, fp.getX(i) * (1 + 0.08 * frontness));
        }
        footGeo.computeVertexNormals();
      }
      const foot = new THREE.Mesh(footGeo, pawMat);
      addWithOutline(footG, foot, 0.024);

      // Toe CLEFTS — the sheet's toes are NOT protruding volumes: the foot
      // is ONE smooth mound and the toes are two short slice LINES cut
      // into the front-top surface. Rendered like the smile arc: thin
      // grey strokes half-buried in the surface, running from the front
      // edge back over the top.
      const cleftMat = bmat(PAL.outline);
      for (const cx of [-0.041, 0.041]) {
        const cleftGeo = new THREE.CylinderGeometry(0.0065, 0.0065, 0.095, 8);
        const cleft = new THREE.Mesh(cleftGeo, cleftMat);
        cleft.position.set(cx, 0.005, 0.21);
        // Wrap the foot's front EDGE (≈60° tilt): reads as a short
        // vertical slice from the front — the sheet's view — and a short
        // line over the top from above. Flatter strokes showed as dots.
        cleft.rotation.x = 1.05;
        footG.add(cleft);
      }
    };

    buildLeg(this.leftLeg, -1);
    buildLeg(this.rightLeg, 1);

    // Outfit roles: leg stub = fur; foot + toes = accent (reads as "boots"
    // when an outfit dyes the accent slot).
    for (const leg of [this.leftLeg, this.rightLeg]) {
      this._tagPaletteRoles(leg, [
        [furMat, 'fur'],
        [pawMat, 'accent'],
      ]);
    }
  }

  // ── Tail ─────────────────────────────────────────────────────────────────
  //  The reference sheet's signature: a BIG low-slung fox brush. Off the
  //  tail-bone it heads down-and-back, the fat fluffy mass lies at LEG
  //  height beside the body (resting on the character's right in every
  //  sheet view), and the final quarter swooshes UP so the soft split tip
  //  flicks to about hip height. Top edge serrated with sculpted fur
  //  scallops; underside smooth.
  //
  //  Coordinate frame: the tail group's rotation.x = -1.62 (constructor)
  //  maps local +Y → world BACK and local +Z → world UP; the spine dips
  //  along −Z (droop) with a t⁶ up-flick at the end. One continuous
  //  varying-radius tube (split into three chained joint sections) fills
  //  the curve; the tip teardrops follow the end tangent.
  private _buildTail(): void {
    const furMat = tmat(PAL.fur, { emissiveBoost: 0.09 });

    // LOW-SLUNG BRUSH (sheet-checked, third pass): in every reference view
    // the tail's mass DROOPS to leg height — off the tailbone it heads
    // down-and-back, the fat brush lies low beside the legs, and only the
    // final quarter swooshes UP so the soft tip flicks to about hip height.
    // (Pass 1 streamed a long flame far behind; pass 2 curled up to chest
    // height — both wrong.) Local frame: +Y = back, +Z = up.
    //   y(t): backward run.  z(t): parabolic dip (max ≈ −0.27 at mid) with
    //   a t⁶ up-flick that only bites near the tip.
    // The sheet's tail end is a J-HOOK: the last quarter turns up hard and
    // the very tip points up/slightly back-over. Two flick terms build it —
    // t^3.5 spreads the main rise over the back half (a single tight bend
    // folded tube rings inside-out in an early build), and a small t^9 term
    // bites only at the very end for the hook. Tip tops out around
    // mid-back/neck height like the sheet's side view. Curvature check:
    // k·r ≈ 0.05 at the hook — far under the ring-fold threshold.
    const spineY = (t: number) => 0.62 * t;
    const spineZ = (t: number) =>
      -1.1 * t * (1 - t) + 0.45 * Math.pow(t, 3.5) + 0.10 * Math.pow(t, 9);
    // Tangent of the spine curve (d/dt), for scallop frames + tip direction
    const tangent = (t: number): [number, number] =>
      [0.62, -1.1 * (1 - 2 * t) + 1.575 * Math.pow(t, 2.5) + 0.9 * Math.pow(t, 8)];

    // Flame body — ONE continuous varying-radius tube along the parabola
    // (16 rings × 32 radial segments). FAT like the sheet: the plume's max
    // radius is ~0.32 (≈ 70% of the body's half-width), swelling from a
    // narrow root and melting into the tip.
    // Bell stretched past the domain end (t/1.08) so the tube stays fat at
    // t=0.95 — a thin end let the tip lock's bulb poke through the surface
    // and expose its outline shell as a grey patch in the crook. Root floor
    // 0.16: the sheet's brush emerges from behind the body ALREADY CHUNKY —
    // no thin stalk at the tail-bone.
    const radiusAt = (t: number) => {
      const bell = Math.sin(Math.min(1, t / 1.08) * Math.PI);
      return 0.16 + Math.pow(bell, 0.95) * 0.18;
    };
    // ── Three chained sections (root → mid → tip joints) ─────────────────
    // The flame is split at t = 0.35 and 0.68 into three tube sections on
    // chained groups, so update() can lag the mid/tip sway behind the root
    // for whip-like follow-through. Sections OVERLAP their joints by a few
    // hundredths of t — the overlap rings tuck inside the next section, so
    // the modest joint bends (≤ ~0.22 rad) never open a visible seam.
    //
    // Fur serration is sculpted INTO each surface: the TOP/OUTER edge waves
    // in and out (five scallop crests over the full tail, fading at both
    // ends) while the underside stays smooth like the sheet. Earlier
    // attempts glued separate teardrop meshes on — their round bases read
    // as balls, not fur. ringAngle a: sin(a) < 0 is the top/outer side.
    const JOINT_MID = 0.35;
    const JOINT_TIP = 0.68;

    // Fur serration shared by surface + shells. Primary crests (four over
    // the brush) + a fine second harmonic — the sheet's brush outline has
    // both big locks and small flicks. ringAngle a: sin(a) < 0 = top edge.
    const scallopFor = (t0: number, t1: number) => (frac: number, a: number) => {
      const tGlobal = t0 + frac * (t1 - t0);
      const topness = Math.max(0, -Math.sin(a));
      const fade = Math.sin(Math.min(1, tGlobal / 0.95) * Math.PI);
      const wave = Math.pow(Math.abs(Math.sin(tGlobal * Math.PI * 4.0 + 0.4)), 0.9);
      const micro = Math.pow(Math.abs(Math.sin(tGlobal * Math.PI * 9.0 + 1.3)), 1.1);
      return 1
        + 0.24 * Math.pow(topness, 1.6) * wave * fade
        + 0.08 * Math.pow(topness, 1.9) * micro * fade;
    };

    const sectionTube = (
      tList: number[],
      base: number,
      capScale = 0.95
    ): THREE.BufferGeometry => {
      const pts: Array<[number, number]> = [];
      const radii: number[] = [];
      for (const t of tList) {
        pts.push([spineY(t) - spineY(base), spineZ(t) - spineZ(base)]);
        radii.push(radiusAt(t));
      }
      // 0.95 xSquash: near-round cross-section — the sheet's brush is a
      // full fluffy volume, not a flattened fin.
      return flameTubeGeo(
        pts,
        radii,
        32,
        0.95,
        scallopFor(tList[0], tList[tList.length - 1]),
        capScale
      );
    };

    // Each section's SURFACE overlaps its joints (t0..t1) so bends never
    // open the skin — but its outline SHELL is built from the TRIMMED
    // domain (shellT0..shellT1) only. Two hard-won rules here:
    //  1. Trimmed shells: a shell over the overlap rings sat 1.2% proud of
    //     the NEIGHBOUR section's identical surface and showed as a grey
    //     band at every joint.
    //  2. The shell's rings are FILTERED FROM THE SURFACE'S OWN t-grid —
    //     never resampled. A shell on its own grid samples the fur
    //     scallops at shifted phases, and its aliased crests poked grey
    //     through the surface's troughs (the zigzag at the hook crook).
    //     Same grid ⇒ shell = surface × 1.012 everywhere ⇒ can't cross.
    const buildSection = (
      parent: THREE.Object3D,
      t0: number,
      t1: number,
      base: number,
      rings: number,
      shellT0: number,
      shellT1: number
    ): void => {
      const tsAll: number[] = [];
      for (let i = 0; i < rings; i++) {
        tsAll.push(t0 + (i / (rings - 1)) * (t1 - t0));
      }
      const mesh = new THREE.Mesh(sectionTube(tsAll, base), furMat);
      parent.add(mesh);

      const tsShell = tsAll.filter(
        (t) => t >= shellT0 - 1e-6 && t <= shellT1 + 1e-6
      );
      // Near-flat caps (0.1) — a domed shell cap bulges past the joint and
      // pokes grey out of the neighbouring section's crook.
      const shellGeo = sectionTube(tsShell, base, 0.1);
      // NORMAL-OFFSET shell, not origin-scaling: scaling about the section
      // origin pushes the shell radially, which in the dip's CONCAVE top
      // lifts it up out of the white surface — the last of the grey-patch
      // family. A constant offset along vertex normals keeps the shell a
      // uniform 8 mm proud and provably inside any concavity shallower
      // than the curvature radius (~0.8 here ≫ 0.008).
      const sPos = shellGeo.attributes.position;
      const sNrm = shellGeo.attributes.normal;
      const SHELL_D = 0.008;
      for (let i = 0; i < sPos.count; i++) {
        sPos.setXYZ(
          i,
          sPos.getX(i) + sNrm.getX(i) * SHELL_D,
          sPos.getY(i) + sNrm.getY(i) * SHELL_D,
          sPos.getZ(i) + sNrm.getZ(i) * SHELL_D
        );
      }
      const shell = new THREE.Mesh(shellGeo, OUTLINE_MAT);
      shell.renderOrder = -1;
      parent.add(shell);
    };

    // Root section rides the tail group itself. Surface overlaps reach
    // ±0.06-0.08 t past each joint — the follow-through bends SIDEWAYS
    // (rotation.z), and the earlier ±0.03 overlap was thinner than the
    // worst-case bend excursion, flashing the shell's grey interior at the
    // joint's side faces mid-sway.
    buildSection(this.tail, 0.0, JOINT_MID + 0.08, 0.0, 18, 0.0, JOINT_MID);

    // Mid joint at the t=0.35 spine point
    const tailMid = new THREE.Group();
    tailMid.position.set(0, spineY(JOINT_MID), spineZ(JOINT_MID));
    this.tail.add(tailMid);
    // Mid shell ends 0.01 short of the tip joint — with the J-hook the
    // bend concentrates right at this joint, and butted flat shell caps
    // peeked grey out of the concave crook; the tiny outline gap hides in
    // the concavity.
    buildSection(
      tailMid, JOINT_MID - 0.06, JOINT_TIP + 0.08, JOINT_MID, 18,
      JOINT_MID, JOINT_TIP - 0.01
    );
    this.tailMid = tailMid;

    // Tip joint at the t=0.68 spine point (position relative to the mid)
    const tailTip = new THREE.Group();
    tailTip.position.set(
      0,
      spineY(JOINT_TIP) - spineY(JOINT_MID),
      spineZ(JOINT_TIP) - spineZ(JOINT_MID)
    );
    tailMid.add(tailTip);
    // 18 rings here — the up-flick concentrates curvature in this section.
    // Shell starts 0.02 past the joint (see the mid-shell note above).
    buildSection(
      tailTip, JOINT_TIP - 0.06, 0.95, JOINT_TIP, 20,
      JOINT_TIP + 0.02, 0.95
    );
    this.tailTip = tailTip;

    // Tip fluff — the sheet's brush ends in a SPLIT soft point: a rounded
    // curling lock plus shorter curls behind it. All ride the tip joint so
    // they whip with the follow-through.
    const [ty, tz] = tangent(0.95);
    const tlen = Math.hypot(ty, tz);
    const tipDirY = ty / tlen;
    const tipDirZ = tz / tlen;
    // Main lock: SHORT and FAT, sunk deep into the tube end, angled 20%
    // past the tangent so it CURLS with the hook — and shell-less like its
    // sibling locks. (The earlier long thin outlined teardrop stuck
    // straight out along the tangent and read as a hard cone spike at the
    // very tip of the tail.)
    const tipMain = new THREE.Mesh(fluffGeo(0.155, 0.30, 26, 20), furMat);
    tipMain.position.set(
      0,
      spineY(0.95) - spineY(JOINT_TIP) - tipDirY * 0.10,
      spineZ(0.95) - spineZ(JOINT_TIP) - tipDirZ * 0.10
    );
    tipMain.rotation.x = Math.atan2(tipDirZ, tipDirY) + 0.20;
    tailTip.add(tipMain);

    // Secondary + tertiary curls beside the main point — the sheet's tip
    // splits into THREE soft paintbrush locks. Both are added WITHOUT
    // outline shells: a shell on a barely-embedded fluff draws a grey halo
    // leaf around its insertion (that was the grey patch at the bend
    // crook), and shell-less white-on-white locks need no linework.
    const tipSide = new THREE.Mesh(fluffGeo(0.100, 0.23, 20, 16), furMat);
    tipSide.position.set(
      0,
      spineY(0.88) - spineY(JOINT_TIP) - tipDirY * 0.04,
      spineZ(0.88) - spineZ(JOINT_TIP) - 0.02
    );
    tipSide.rotation.x = Math.atan2(tipDirZ, tipDirY) - 0.62;
    tailTip.add(tipSide);

    const tipThird = new THREE.Mesh(fluffGeo(0.070, 0.18, 18, 14), furMat);
    tipThird.position.set(
      0,
      spineY(0.92) - spineY(JOINT_TIP) - tipDirY * 0.03,
      spineZ(0.92) - spineZ(JOINT_TIP) + 0.02
    );
    tipThird.rotation.x = Math.atan2(tipDirZ, tipDirY) + 0.45;
    tailTip.add(tipThird);

    // Crook filler — fur bunches on the inside of a bend. The J-hook's
    // concave V between the mid tube and the rising tip opened a sliver
    // that showed the outline shell's grey interior behind it; this white
    // lock nestles in the crook (bulb overlapping both tubes, no outline)
    // and closes the gap the way the sheet's fur actually behaves.
    const crookFill = new THREE.Mesh(fluffGeo(0.105, 0.26, 20, 16), furMat);
    crookFill.position.set(
      0,
      spineY(0.71) - spineY(JOINT_TIP),
      spineZ(0.71) - spineZ(JOINT_TIP) + 0.05
    );
    crookFill.rotation.x = 1.15;   // points up-back along the bend bisector
    tailTip.add(crookFill);

    // Outfit roles: the whole plume = fur (the sheet's tail is one colour;
    // furDeep/cream tail slots from the fox-marking era are gone).
    this._tagPaletteRoles(this.tail, [[furMat, 'fur']]);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Switch to a new animation state and update the logical facing direction.
   * Call this whenever input or network packets change the character's intent.
   */
  setState(newState: CharacterState, networkRotation: number): void {
    this.currentState    = newState;
    this.logicalRotation = networkRotation;
  }

  /**
   * Dress the rig in an outfit: absolute palette-role recolor + optional head
   * accessory. Additive to the frozen API (TR3, issue #35).
   *
   * Hazards handled (all learned in #27's applyPeerTint):
   *  - materials are shared across meshes within the rig → dedupe via a Set;
   *  - outline shells share the module-wide OUTLINE_MAT → skip it (recoloring
   *    it would repaint every rig's outlines at once);
   *  - offsetHSL is cumulative → absolute color.setHex only;
   *  - tmat() seeds emissive from the same hex as color → mirror the recolor
   *    into emissive so it holds up in dim light (only when it was seeded).
   *
   * Roles absent from paletteOverrides are restored to their pristine PAL
   * color, so outfit-to-outfit switches never leave stale colors and applying
   * the same outfit twice is exactly idempotent.
   */
  setOutfit(outfit: OutfitDef): void {
    const seen = new Set<THREE.Material>();
    this.visualGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const role = mesh.userData.paletteRole as PaletteRole | undefined;
      if (!role) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m || m === OUTLINE_MAT || seen.has(m)) continue;
        seen.add(m);
        const mat = m as THREE.MeshToonMaterial;
        if (!mat.color) continue;
        // Capture pristine values BEFORE the first mutation — the exact
        // restore source for clearOutfit and un-overridden roles.
        let orig = this.outfitOriginals.get(mat);
        if (!orig) {
          orig = {
            color: mat.color.getHex(),
            emissive: mat.emissive ? mat.emissive.getHex() : 0,
            emissiveSeeded:
              !!mat.emissive && mat.emissive.getHex() === mat.color.getHex(),
          };
          this.outfitOriginals.set(mat, orig);
        }
        const target = outfit.paletteOverrides[role] ?? orig.color;
        mat.color.setHex(target);
        if (mat.emissive && orig.emissiveSeeded) mat.emissive.setHex(target);
      }
    });
    this.removeAccessory();
    if (outfit.accessory) this.attachAccessory(outfit.accessory);
  }

  /** Restore every outfit-touched material to its pristine color/emissive and
   *  detach any accessory. Exact inverse of setOutfit (no drift). */
  clearOutfit(): void {
    for (const [mat, orig] of this.outfitOriginals) {
      mat.color.setHex(orig.color);
      if (mat.emissive) mat.emissive.setHex(orig.emissive);
    }
    this.removeAccessory();
  }

  /**
   * Attach one procedural accessory to the HEAD group (single slot — replaces
   * any current accessory). Parented under this.head, so it inherits every
   * walk-bob / sit / facing transform with zero animation wiring.
   */
  attachAccessory(kind: AccessoryKind): void {
    this.removeAccessory();
    const g =
      kind === 'cap'   ? this._buildCapAccessory()   :
      kind === 'visor' ? this._buildVisorAccessory() :
                         this._buildScarfAccessory();
    g.name = `accessory:${kind}`;
    this.head.add(g);
    this.accessoryGroup = g;
  }

  /** Detach and dispose the current accessory (if any). Follows the despawn
   *  discipline from world.ts: dedupe geometries/materials via a Set and
   *  NEVER dispose the shared OUTLINE_MAT (outline shells reuse host geo). */
  removeAccessory(): void {
    const g = this.accessoryGroup;
    if (!g) return;
    this.head.remove(g);
    const disposed = new Set<THREE.BufferGeometry | THREE.Material>();
    g.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry && !disposed.has(mesh.geometry)) {
        disposed.add(mesh.geometry);
        mesh.geometry.dispose();
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat || mat === OUTLINE_MAT || disposed.has(mat)) continue;
        disposed.add(mat);
        mat.dispose();
      }
    });
    this.accessoryGroup = null;
  }

  /**
   * Advance the animation by one frame.
   * Call this inside your requestAnimationFrame / game-loop update.
   */
  /** 🍹 Drink-hold override (waiter-bot serve): 0 = paw reaching forward at
   *  waist height, 1 = raised to the muzzle; null = normal arm animation. */
  private drinkHold: number | null = null;

  public setDrinkHold(raise: number | null): void {
    this.drinkHold = raise;
  }

  /** World position of the right paw (the drink rides in it while sipping).
   *  -0.47 = the mitten-paw centre in the reference-sheet arm build. */
  public getPawWorldPos(target: THREE.Vector3): THREE.Vector3 {
    this.rightArm.updateWorldMatrix(true, false);
    return this.rightArm.localToWorld(target.set(0, -0.47, 0));
  }

  update(): void {
    // Clamp the frame delta: a backgrounded tab pauses rAF, so on resume
    // getDelta() returns SECONDS. lerp(a, b, t) with t > 1 EXTRAPOLATES past
    // the target and amplifies each frame — the torso (carrying legs/feet)
    // exploded to ±1e17 world units after one alt-tab cycle ("legs and feet
    // shifted below ground"). Clamping both the delta and the lerp factor
    // makes every rig interpolation unconditionally stable.
    const delta = Math.min(this.clock.getDelta(), 0.1);
    const time  = this.clock.getElapsedTime();
    const state = STATES[this.currentState];

    const lerpSpeed = Math.min(10 * delta, 1);

    // ── 1. Root height interpolation (for sitting states) ────────────────────
    this.torso.position.y = THREE.MathUtils.lerp(
      this.torso.position.y,
      state.rootY - 0.15,  // chibi torso sits lower than adult
      lerpSpeed
    );

    // Whole-body recline (🛏️ sleep pose) — every other state converges back
    // to upright through the same lerp, so wake-up needs no special casing.
    this.torso.rotation.x = THREE.MathUtils.lerp(
      this.torso.rotation.x,
      state.bodyRotX ?? 0,
      lerpSpeed
    );

    // ── 2. Limb rotations + tail sway ────────────────────────────────────────
    if (this.currentState === 'walk') {
      const walkSpeed   = 8;
      const strideAngle = Math.PI / 4;

      const leftPhase  = Math.sin(time * walkSpeed)            * strideAngle;
      const rightPhase = Math.sin(time * walkSpeed + Math.PI)  * strideAngle;

      this.leftLeg.rotation.x  = THREE.MathUtils.lerp(this.leftLeg.rotation.x,  leftPhase,  lerpSpeed);
      this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, rightPhase, lerpSpeed);
      this.leftArm.rotation.x  = THREE.MathUtils.lerp(this.leftArm.rotation.x,  rightPhase, lerpSpeed);
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, leftPhase,  lerpSpeed);

      this.torso.position.y = (state.rootY - 0.15) + Math.abs(Math.sin(time * walkSpeed)) * 0.09;

      // Tail sway — bigger amplitude on walk, tail wags side to side around
      // a reduced rest offset (the brush streams closer to centre in motion)
      this.tail.rotation.z = TAIL_REST_YAW * 0.5 + Math.sin(time * walkSpeed * 0.5) * 0.35;

    } else if (this.currentState === 'swim') {
      // 🏊 Gentle paddle: arms alternate at a lazy cadence, legs stay tucked
      // (table value), torso bobs with the water. Same clamped-lerp discipline
      // as walk so an alt-tab resume can't extrapolate.
      const paddle = Math.sin(time * 3.0) * 0.45;
      const legTarget = state.legRotX ?? 0;
      this.leftLeg.rotation.x  = THREE.MathUtils.lerp(this.leftLeg.rotation.x,  legTarget, lerpSpeed);
      this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, legTarget, lerpSpeed);
      this.leftArm.rotation.x  = THREE.MathUtils.lerp(this.leftArm.rotation.x,  paddle,  lerpSpeed);
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, -paddle, lerpSpeed);
      // Water bob rides ON TOP of the root lerp from section 1.
      this.torso.position.y += Math.sin(time * 2.0) * 0.03;
      // Tail drifts slowly like it's floating behind.
      this.tail.rotation.z = TAIL_REST_YAW * 0.5 + Math.sin(time * 1.2) * 0.2;

    } else {
      const legTarget = state.legRotX ?? 0;
      const armTarget = state.armRotX ?? 0;

      this.leftLeg.rotation.x  = THREE.MathUtils.lerp(this.leftLeg.rotation.x,  legTarget, lerpSpeed);
      this.rightLeg.rotation.x = THREE.MathUtils.lerp(this.rightLeg.rotation.x, legTarget, lerpSpeed);
      this.leftArm.rotation.x  = THREE.MathUtils.lerp(this.leftArm.rotation.x,  armTarget, lerpSpeed);
      this.rightArm.rotation.x = THREE.MathUtils.lerp(this.rightArm.rotation.x, armTarget, lerpSpeed);

      // Idle tail — slow gentle sway around the rest offset (the sheet's
      // front view shows the brush resting beside the legs on the
      // character's right, not hidden dead-centre behind them)
      const idleSway = TAIL_REST_YAW + Math.sin(time * 1.5) * 0.12;
      this.tail.rotation.z = THREE.MathUtils.lerp(this.tail.rotation.z, idleSway, lerpSpeed);
    }

    // Tail follow-through — the mid/tip joints lag the root sway (phase
    // offsets ≈0.5/1.0 rad) so the plume WHIPS fluidly down its length
    // instead of waving as one rigid piece. Amplitudes shrink toward the
    // tip; frequencies match each state's root-sway write above.
    if (this.tailMid && this.tailTip) {
      let midTarget: number;
      let tipTarget: number;
      if (this.currentState === 'walk') {
        midTarget = Math.sin(time * 4 - 0.45) * 0.22;
        tipTarget = Math.sin(time * 4 - 0.90) * 0.18;
      } else if (this.currentState === 'swim') {
        midTarget = Math.sin(time * 1.2 - 0.50) * 0.10;
        tipTarget = Math.sin(time * 1.2 - 1.00) * 0.08;
      } else {
        midTarget = Math.sin(time * 1.5 - 0.55) * 0.07;
        tipTarget = Math.sin(time * 1.5 - 1.10) * 0.06;
      }
      this.tailMid.rotation.z = THREE.MathUtils.lerp(this.tailMid.rotation.z, midTarget, lerpSpeed);
      this.tailTip.rotation.z = THREE.MathUtils.lerp(this.tailTip.rotation.z, tipTarget, lerpSpeed);
    }

    // Head life — subtle sway/bob so the oversized skull never reads frozen:
    // a gentle two-axis drift at idle/swim, a stride-locked bob on walk.
    // Other states (seats, sleep, dive) lerp back to neutral because the
    // pose owns the silhouette there.
    const headLifeX = this.currentState === 'walk'
      ? Math.sin(time * 8) * 0.05
      : this.currentState === 'idle' || this.currentState === 'swim'
        ? Math.sin(time * 1.4) * 0.02
        : 0;
    const headLifeZ = this.currentState === 'walk'
      ? Math.sin(time * 4) * 0.04
      : this.currentState === 'idle' || this.currentState === 'swim'
        ? Math.sin(time * 0.9) * 0.03
        : 0;
    this.head.rotation.x = THREE.MathUtils.lerp(this.head.rotation.x, headLifeX, lerpSpeed);
    this.head.rotation.z = THREE.MathUtils.lerp(this.head.rotation.z, headLifeZ, lerpSpeed);

    // 🍹 Drink in the right paw (waiter-bot serve) — OVERRIDES the state arm
    // pose: reaches forward to take the glass, curls up to the muzzle on each
    // sip. Applied after the limb branch so every state converges to it.
    if (this.drinkHold !== null) {
      const target = -(0.9 + this.drinkHold * 1.3);
      this.rightArm.rotation.x = THREE.MathUtils.lerp(
        this.rightArm.rotation.x,
        target,
        Math.min(14 * delta, 1),
      );
    }

    // Face expression — blink + smile. Asleep ⇒ eyes held fully closed (the
    // blink squash at its max) with a soft contented smile.
    const blinkPulse = this.currentState === 'sleep'
      ? 1
      : Math.pow(Math.max(0, Math.sin(time * 2.7)), 20);
    const smileTarget = this.currentState === 'walk' ? 1.0 : 0.65;
    this.smileAmount = THREE.MathUtils.lerp(this.smileAmount, smileTarget, 8 * delta);
    this._updateFaceRig(blinkPulse, this.smileAmount);

    // Breathing — subtle vertical scale on chest
    if (this.chest) {
      const breath = 1 + Math.sin(time * 1.4) * 0.025;
      this.chest.scale.y = breath;
    }

    // Occasional ear twitches during idle
    if (this.currentState !== 'walk' && this.leftEar && this.rightEar) {
      const twitchL = Math.max(0, Math.sin(time * 0.7 - 0.5) - 0.85) * 10;
      const twitchR = Math.max(0, Math.sin(time * 0.6 + 1.1) - 0.85) * 10;
      this.leftEar.rotation.x  = -0.10 + twitchL * -0.35;
      this.rightEar.rotation.x = -0.10 + twitchR * -0.35;
    } else if (this.leftEar && this.rightEar) {
      this.leftEar.rotation.x  = -0.10;
      this.rightEar.rotation.x = -0.10;
    }

    // ── 3. 8-way decoupled snapping ───────────────────────────────────────────
    this.masterGroup.rotation.y = this.logicalRotation;
    this.visualGroup.rotation.y = -this.logicalRotation;
    this.visualGroup.rotation.y += snapTo8Ways(this.logicalRotation);
  }

  private _updateFaceRig(blink: number, smile: number): void {
    if (!this.leftEye || !this.rightEye || !this.mouth) return;

    const eyeScaleY = THREE.MathUtils.lerp(1.0, 0.10, blink);
    this.leftEye.scale.y = eyeScaleY;
    this.rightEye.scale.y = eyeScaleY;

    this.mouth.scale.x = 1.0 + smile * 0.7;
    this.mouth.position.y = 0.215 + smile * 0.015;  // 0.215 = smile-arc build Y
  }

  // ── Accessory builders (TR3, issue #35) ────────────────────────────────────
  //  Small procedural props in the rig's own toon-outline style: same tmat()
  //  factory + addWithOutline() shells for opaque parts. All coordinates are
  //  HEAD-LOCAL (head origin = neck point; skull center y≈0.42, r≈0.62;
  //  ears at x=±0.28, y=0.94; face plane at z=0.61).

  /** Cap: low crown perched between the ears + forward brim + button. */
  private _buildCapAccessory(): THREE.Group {
    const g = new THREE.Group();
    const capMat  = tmat(0x2e6f9e, { emissiveBoost: 0.10 });  // steel blue
    const trimMat = tmat(0xf2e3c8, { emissiveBoost: 0.11 });  // parchment trim

    // Crown — squashed cylinder sitting on the skull dome, between the ears
    // (radius 0.30 just clears the ear bases at x=±0.28).
    const crownGeo = new THREE.CylinderGeometry(0.27, 0.33, 0.17, 20);
    const crown = new THREE.Mesh(crownGeo, capMat);
    crown.position.set(0, 1.04, 0.08);
    addWithOutline(g, crown, 0.03);

    // Dome top — rounds off the crown so the silhouette stays plushie-soft.
    const domeGeo = new THREE.SphereGeometry(0.27, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const dome = new THREE.Mesh(domeGeo, capMat);
    dome.position.set(0, 1.12, 0.08);
    g.add(dome);

    // Brim — flat rounded box jutting forward over the face.
    const brimGeo = new THREE.BoxGeometry(0.44, 0.045, 0.30);
    const brim = new THREE.Mesh(brimGeo, capMat);
    brim.position.set(0, 0.99, 0.42);
    brim.rotation.x = 0.12;   // slight downward tilt
    addWithOutline(g, brim, 0.025);

    // Button on top.
    const button = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), trimMat);
    button.position.set(0, 1.24, 0.08);
    g.add(button);
    return g;
  }

  /** Visor: thin translucent cyan band curved across the face. Translucent →
   *  no outline shell; renderOrder 6 so it composites over the face decal
   *  (renderOrder 5, both depthWrite-off). */
  private _buildVisorAccessory(): THREE.Group {
    const g = new THREE.Group();
    const visorMat = new THREE.MeshBasicMaterial({
      color: 0x63d6e8,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    // Design-opacity marker: zoom.ts's first-person avatar fade scales
    // per-material opacity by (1 − ratio) and restores to this value rather
    // than a blanket 1.0 — without it, one first-person round trip would
    // leave the translucent visor a fully opaque cyan slab.
    visorMat.userData.baseOpacity = 0.35;
    // Open cylinder segment centered on +Z (thetaStart −0.45π..+0.45π), a
    // hair wider than the skull so it floats just off the fur.
    const bandGeo = new THREE.CylinderGeometry(
      0.66, 0.66, 0.20, 32, 1, true, -Math.PI * 0.45, Math.PI * 0.9
    );
    const band = new THREE.Mesh(bandGeo, visorMat);
    band.position.set(0, 0.47, 0.02);
    band.renderOrder = 6;
    g.add(band);

    // Slim dark frame rail along the visor's top edge (opaque anchor).
    const railGeo = new THREE.CylinderGeometry(
      0.665, 0.665, 0.04, 32, 1, true, -Math.PI * 0.48, Math.PI * 0.96
    );
    const rail = new THREE.Mesh(railGeo, tmat(0x30363f, { emissiveBoost: 0.06 }));
    rail.position.set(0, 0.585, 0.02);
    g.add(rail);
    return g;
  }

  /** Scarf: chunky torus band hugging the neck seam + a hanging front flap. */
  private _buildScarfAccessory(): THREE.Group {
    const g = new THREE.Group();
    const scarfMat = tmat(0xb8402e, { emissiveBoost: 0.10 });  // warm red
    // Torus lies in the XZ plane (rotation.x = π/2) right where the skull
    // meets the torso (head-local y≈−0.06); major radius 0.36 threads the
    // skull's ~0.42 cross-section radius at that height through the tube.
    const bandGeo = new THREE.TorusGeometry(0.36, 0.11, 12, 24);
    const band = new THREE.Mesh(bandGeo, scarfMat);
    band.rotation.x = Math.PI / 2;
    band.position.set(0, -0.06, 0.0);
    addWithOutline(g, band, 0.025);

    // Hanging flap off the front-right of the band, clear of the chest ruff.
    const flapGeo = new THREE.BoxGeometry(0.15, 0.30, 0.06);
    const flap = new THREE.Mesh(flapGeo, scarfMat);
    flap.position.set(0.15, -0.24, 0.40);
    flap.rotation.z = 0.18;
    addWithOutline(g, flap, 0.02);
    return g;
  }
}
