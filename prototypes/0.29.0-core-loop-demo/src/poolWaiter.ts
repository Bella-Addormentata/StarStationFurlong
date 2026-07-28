/**
 * 🤖 PoolWaiter — drink-service robot (here: the LOBBY's roaming waiter).
 *
 * A voxel-built waiter bot — monochrome chassis, black polo with a white
 * badge, black sunglasses visor — patrols a fixed ping-pong route through
 * the lobby aisles, carrying a wooden tray of cocktails. When the fox walks
 * up FACING it (close, heading roughly at the bot), the bot stops, turns to
 * the fox, and one drink flies from the tray into the fox's paw, is sipped
 * over five seconds, and drunk (shrinks away). Drinks refill on a timer and
 * a cooldown prevents back-to-back grabs.
 *
 * Purely LOCAL ambience (like the room's other decor pieces) — not networked:
 * every client simulates its own waiter, and only the local fox is served.
 * (Same bot as the pool room's waiter on the pool branch — the patrol route
 * is a constructor parameter so each room hands it its own floor plan.)
 */
import * as THREE from "three";
import type { Player } from "./player";
import {
  CELL_SIZE, findPath, worldToCol, worldToRow, nearestWalkableCell,
} from "./pathfinding";
import type { WorkoutPose } from "./voxelCharacter";
import type { RobotRoutine, RobotStep } from "./robotDoc";

const WALK_SPEED = 1.15; // leisurely service pace (fox walks 2.8)
const TURN_RATE = 9; // exponential turn smoothing factor
/** Whole-bot scale: native build is 1.8 tall; ×1.4 ≈ 2.5 = 75% of the fox's
 *  measured 3.33 bbox height. The tray + drinks ride the same scale. */
const ROBOT_SCALE = 1.4;
/** 🦵 Hip pivot height — squats drop the hips (and torso) by the thigh-fold
 *  shortening so the feet stay planted while the knees bend. */
const HIP_Y = 0.98;
/** 🗨️ World-space anchor for the bot's overhead lines — just above the
 *  scaled antenna (≈3.1), co-owned with the geometry so a rebuild that
 *  changes the bot's height updates the bubbles with it. */
export const ROBOT_BUBBLE_Y = 3.3;
const SERVE_RANGE = 1.6; // fox this close AND facing the bot → serve
const FACING_DOT = 0.55; // min cos(angle fox-heading → bot) to count as 迎面
const ABORT_RANGE = 3.0; // fox wandered off before the sip → finish quietly
const OFFER_TIME = 0.5; // bot stops and turns to the fox
const FLY_TIME = 0.6; // drink arcs tray → the fox's paw
const SIP_TIME = 5.0; // held in the paw, sipped over five seconds
const SIP_CYCLES = 3; // paw-to-muzzle raises across the sip
const GULP_TIME = 0.3; // drink shrinks away (drunk!)
const SERVE_COOLDOWN = 6; // s before the next drink can be grabbed
const DOCK_AFTER_SECS = 12; // 🔌 idle this long with no fox near → return to dock
const DOCK_WAKE_RANGE = 4.5; // 🔌 a fox this close wakes the bot off the dock
const REFILL_TIME = 14; // s until an emptied tray slot is restocked
const SMALLTALK_RANGE = 3.2; // 🗨️ #77: fox newly this close → one greeting line
const SMALLTALK_COOLDOWN_SECS = 45; // per bot — greet, don't pester
// (The glass is anchored to the fox's actual PAW via getPawWorldPos — the
//  rig's drink-hold arm pose decides where waist/muzzle land, so no fixed
//  hand/mouth heights are needed here.)
const DRINK_ARC_LIFT = 0.35; // parabola apex above the fly chord

/**
 * 🛋️ LOBBY patrol route (world coords, ping-pong). Hand-authored through the
 * open aisles of the default floor plan: the x ±2.6 corridors either side of
 * the central sofa/coffee-table cluster, joined by the south promenade in
 * front of the wall computer (clear of the SE bar corner and the crowded
 * north band with the map table / bunk / clone vat).
 */
export const LOBBY_PATROL: Array<[number, number]> = [
  [-2.6, -2.8],
  [2.6, -2.8],
  [2.6, 2.3],
  [2.2, 4.3], // south promenade — clear of the relocated armchairs (z 5.15)
  [-2.4, 4.3],
];

/**
 * 🏝️ POOL-ROOM patrol route (world coords, ping-pong). Hand-authored on the
 * open deck: south promenade in front of the loungers → east lane INSIDE the
 * parasol café sets (poles at x 4.6) → north deck, passing in FRONT of the
 * dive tower (base at 0, -4.35). The west edge is the infinity drop — no
 * corridor there.
 */
export const POOL_PATROL: Array<[number, number]> = [
  [-4.2, 3.9],
  [1.2, 4.05],
  [3.7, 3.8],
  [3.95, 2.6],
  [3.95, -2.6],
  [3.3, -3.95],
  [1.2, -3.5],
  [-1.2, -3.5],
  [-3.2, -3.9],
  [-4.6, -3.9],
];

/** 🎰 CASINO patrol route (world coords, ping-pong). The central floor is
 * occupied by two dense table columns, so service stays in the open east
 * aisle and turns along the north/south promenades without clipping booths. */
export const CASINO_PATROL: Array<[number, number]> = [
  [3.25, -4.2],
  [3.4, -2.2],
  [3.4, 0],
  [3.4, 2.2],
  [3.25, 4.15],
];

/** 🗨️ #77 small talk — one line, edge-triggered, when a fox first steps into
 *  SMALLTALK_RANGE (per-bot cooldown). Spoken through the sayHandler, so it
 *  rides the same bubble + speaker-voice pipeline as scripted 'say' lines.
 *  Pool picked by what the bot is doing; croupier/custom/parked bots never
 *  small-talk (their paths return before the patrol/dock tail). */
const SMALLTALK_PATROL: readonly string[] = [
  "Welcome aboard, traveler!",
  "Lovely orbit tonight, isn't it?",
  "Care for a drink? Just wave me down.",
  "The wheel's been lucky today. Feeling bold?",
  "Enjoy your stay on Furlong Station!",
];
const SMALLTALK_CHARGING: readonly string[] = [
  "Recharging… back on duty in a jiffy.",
  "Low on volts, high on spirits.",
  "Just topping up my cells — don't mind me.",
];
/** 🏋️ #77 coach routine — the demo class the bot loops: announce a move,
 *  demonstrate its reps, rest, next move. `repSecs` paces ONE full rep; every
 *  rep's pose derives from a half-sine so it starts and ends at neutral. */
const COACH_MOVES = [
  { name: 'squat', call: 'Squats — follow me! Eight reps!', reps: 8, repSecs: 2.0 },
  { name: 'jack', call: 'Jumping jacks! Arms up — eight!', reps: 8, repSecs: 0.9 },
  { name: 'lunge', call: 'Lunges — alternate legs, nice and low!', reps: 8, repSecs: 1.8 },
] as const;
/** Rep count words, spoken as each rep begins ("One!" … "Eight!"). */
const COUNT_WORDS: readonly string[] = [
  'One!', 'Two!', 'Three!', 'Four!', 'Five!', 'Six!', 'Seven!', 'Eight!',
];
/** Squat/lunge pacing: ease DOWN (40%), HOLD at the bottom (25%), ease back
 *  UP (35%) — the hold is what makes the rep read as a real squat instead of
 *  a bounce. Jumping jacks keep a plain half-sine (they ARE a bounce). */
function holdCurve(t: number): number {
  if (t < 0.4) return Math.sin((t / 0.4) * (Math.PI / 2));
  if (t > 0.65) return Math.sin(((1 - t) / 0.35) * (Math.PI / 2));
  return 1;
}
/** THE per-move rep curve — one source for the robot's demo and the fox's
 *  mirror, so the two rigs can't fall out of step. */
function curveFor(name: (typeof COACH_MOVES)[number]['name'], t: number): number {
  return name === 'jack' ? Math.sin(Math.PI * t) : holdCurve(t);
}
const COACH_ANNOUNCE_SECS = 1.6; // beat between the call and the first rep
const COACH_REST_SECS = 4;
const COACH_REST_LINES: readonly string[] = [
  'And done — shake it out!',
  'Great set! Breathe…',
  'Nice form! Quick breather.',
];
/** Proximity invite (the coach's flavour of small talk). */
const COACH_INVITES: readonly string[] = [
  'Join me for a set?',
  'Workout time — follow along if you like!',
  'A fit clone is a happy clone. Care to try?',
];

/** 🍹 Spoken once as a serve begins (the OFFER turn-to-face) — the #77
 *  "stopping to ask if a person would like a drink" beat. One line per serve;
 *  SERVE_COOLDOWN already spaces repeat serves. */
const SERVE_LINES: readonly string[] = [
  "Care for a drink? Fresh off the tray!",
  "One cosmic cooler, just for you.",
  "You look thirsty — here you go!",
  "A refreshment for the distinguished guest.",
  "Compliments of the house — enjoy!",
];

/** Cocktail colours (glass body / garnish) — matches the reference tray. */
const DRINKS: Array<{ body: number; garnish: number }> = [
  { body: 0xd94a4a, garnish: 0x74c04e }, // strawberry red / lime
  { body: 0xf2d24e, garnish: 0xd94a4a }, // lemonade yellow / cherry
  { body: 0xe8833a, garnish: 0xf2d24e }, // sunset orange / lemon
  { body: 0x74c04e, garnish: 0xffffff }, // lime green / cream
];

type ServePhase = "NONE" | "OFFER" | "FLY" | "SIP" | "GULP";

interface DrinkSlot {
  group: THREE.Group;
  /** Tray-local rest position (restored on refill). */
  home: THREE.Vector3;
  consumed: boolean;
  refillAt: number;
}

export class PoolWaiter {
  public group = new THREE.Group();

  private scene: THREE.Scene;
  private legL!: THREE.Group;
  private legR!: THREE.Group;
  private body!: THREE.Group;
  private tray!: THREE.Group;
  /** 🏋️ Shoulder-pivoted arm groups (rotation zero = tray-carry pose). */
  private armL!: THREE.Group;
  private armR!: THREE.Group;
  /** 🦵 Knee-pivoted shin subgroups (inside legL/legR) — squat knee bend. */
  private shinL!: THREE.Group;
  private shinR!: THREE.Group;
  private drinks: DrinkSlot[] = [];

  private time = 0;
  private heading = 0;
  private patrolIndex = 0;
  private patrolDir: 1 | -1 = 1;

  private servePhase: ServePhase = "NONE";
  private serveTimer = 0;
  private serveDrink: DrinkSlot | null = null;
  /** Fox being served — its drink-hold arm pose is released on finish. */
  private servedPlayer: Player | null = null;
  /** Scratch vector for the paw-anchor lookup (no per-frame allocation). */
  private pawTmp = new THREE.Vector3();
  private flyFrom = new THREE.Vector3();
  /** World scale the drink inherits from the ×ROBOT_SCALE bot when handed to
   *  the scene — the GULP shrink starts from here, and it keeps the drink the
   *  same size in the fox's paw as it was on the tray. */
  private flyScale = 1;
  private cooldown = 0;

  /** Waypoint loop this bot walks (ping-pong) — per-room floor plan. */
  private patrol: Array<[number, number]>;

  /** 🔌 #77 Phase A: charging-dock target (world pos + facing), set per room by
   *  the world from a placed 'charging-dock' item; null ⇒ pure patrol (no dock
   *  behaviour). When idle past DOCK_AFTER_SECS with no fox near, the bot walks
   *  here and plays a charge pose until a fox approaches. */
  private dockTarget: { x: number; z: number; faceAngle: number } | null = null;
  /** 🎰🤖 #77 Phase B: the roulette wheel-head post (world pos + facing). When
   *  set (the room has a roulette table), the bot leaves patrol/dock, walks to
   *  the head of the wheel, and stands the table as the croupier. Overrides dock
   *  and serving — one bot per client, croupier duty first. */
  private croupierPost: { x: number; z: number; faceAngle: number } | null = null;
  private activity: "PATROL" | "DOCK" | "CROUPIER" = "PATROL";
  private idleTimer = 0;
  /** 🤖 #77C s3: owner-programmed routine (the dock's console writes it, synced).
   *  'serve' = patrol + serve + dock when idle (default); 'croupier' = only run a
   *  roulette table (else wait at the dock); 'idle' = just wait at the dock;
   *  'custom' = loop the owner-authored `script`. */
  private routine: RobotRoutine = "serve";
  /** 🤖 STOP/START: when true the bot parks on its dock (off), overriding the
   *  routine + croupier duty. Set from the dock console via the world. */
  private parked = false;
  /** 🤖 #77C s4: the custom step list (routine 'custom') + loop cursor/timer, and
   *  the world-provided handler that renders a 'say' bubble over the bot. */
  private script: RobotStep[] = [];
  private scriptIndex = 0;
  private scriptTimer = 0;
  private saidThisStep = false;
  /** Returns whether the line was actually delivered (the world drops lines
   *  during its room-entry quiet window) — droppers must not burn cooldowns. */
  private sayHandler: ((text: string, x: number, z: number) => boolean) | null = null;
  /** 🗨️ #77 small talk: greet once when a fox newly enters range, then hold off. */
  private smalltalkCooldown = 0;
  private foxWasNear = false;
  /** 🏋️ coach-routine state: which move, where in its announce/reps/rest
   *  cycle, and the once-per-phase say latch. */
  private coachMove = 0;
  private coachPhase: 'announce' | 'reps' | 'rest' = 'announce';
  private coachTimer = 0;
  private coachRep = 0;
  private coachSaid = false;
  /** 🎥 Camera-facing yaw while coaching (world-provided; null = dock facing). */
  private stageYaw: number | null = null;
  /** 🏋️ The class stage — open floor nearest room centre (lazy, per class). */
  private coachStage: { x: number; z: number } | null = null;
  /** 🧭 #77C in-room nav: the A*-routed world-space waypoints toward the current
   *  walk goal (routes around furniture / through door openings instead of
   *  clipping straight through), and the goal they were computed for. */
  private path: Array<{ x: number; z: number }> = [];
  private pathGoalKey = "";

  constructor(
    scene: THREE.Scene,
    patrol: Array<[number, number]> = LOBBY_PATROL,
    spawnPos?: { x: number; z: number },
  ) {
    this.scene = scene;
    this.patrol = patrol;
    this.group.name = "pool-waiter";
    this.build();
    this.group.scale.setScalar(ROBOT_SCALE);
    // #77C: a dock robot spawns AT its dock; the ambient waiter starts on its
    // patrol route.
    const [sx, sz] = spawnPos ? [spawnPos.x, spawnPos.z] : this.patrol[0];
    this.group.position.set(sx, 0, sz);
    scene.add(this.group);
  }

  /** World-space footprint of the bot (x,z) — used to pick the nearest robot
   *  for a croupier post (#77C multi-robot). */
  public getPosition(): { x: number; z: number } {
    return { x: this.group.position.x, z: this.group.position.z };
  }

  // ── Voxel build (front = +z at rotation 0) ─────────────────────────────────

  private mat(
    color: number,
    rough = 0.7,
    metal = 0.25,
  ): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: rough,
      metalness: metal,
    });
  }

  private box(
    parent: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /** 🏋️ Cylindrical limb segment (owner request: rounded, high-contrast limbs
   *  so the coach's exercise moves read clearly). Same contract as box(). */
  private tube(
    parent: THREE.Object3D,
    radius: number,
    height: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, height, 12),
      mat,
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private build(): void {
    // ⬛⬜ Monochrome livery: white chassis panels, black joints/servos,
    // black polo with white collar + badge, white shorts, black visor.
    const STEEL = this.mat(0xf1f3f5, 0.55, 0.35); // white chassis
    const JOINT = this.mat(0x191c20, 0.6, 0.4); // black joints
    const COLLAR = this.mat(0xf1f3f5, 0.85, 0.02); // white collar
    const SHORTS = this.mat(0xe8ebee, 0.8, 0.08); // white shorts
    const VISOR = this.mat(0x14181c, 0.35, 0.1); // sunglasses band
    const WOODY = this.mat(0x8a5a2e, 0.8, 0.05); // tray timber
    // 🏋️ High-contrast limb colours (owner request): coral arms, sky-blue
    // legs — each limb reads at a glance mid-exercise.
    const ARM = this.mat(0xff7043, 0.55, 0.15); // coral sleeves
    const LEG = this.mat(0x36c6f0, 0.55, 0.15); // sky-blue tights

    // Legs — hip-pivoted groups so they can swing while walking.
    for (const side of [-1, 1] as const) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.15, HIP_Y, 0); // 🏋️ athletic legs — hip pivot
      this.tube(leg, 0.075, 0.46, LEG, 0, -0.23, 0); // thigh
      this.tube(leg, 0.05, 0.1, JOINT, 0, -0.47, 0); // knee servo
      // 🦵 Shin subgroup pivoted at the KNEE so a squat bends like a human
      // leg — thigh folds forward, shin counter-rotates to stay upright.
      const shin = new THREE.Group();
      shin.position.set(0, -0.48, 0);
      leg.add(shin);
      this.tube(shin, 0.065, 0.36, LEG, 0, -0.24, 0); // shin
      this.box(shin, 0.18, 0.09, 0.3, JOINT, 0, -0.455, 0.05); // foot
      this.group.add(leg);
      if (side < 0) {
        this.legL = leg;
        this.shinL = shin;
      } else {
        this.legR = leg;
        this.shinR = shin;
      }
    }

    // Body group (shorts → abs chassis → head) — bobs as one while walking.
    // 🏋️ Athletic rebuild (owner request): FLAT slab torso (not a barrel) in
    // a V-taper — broad flat chest over a narrow waist — with a sculpted
    // SIX-PACK front: two pec plates up top, a 2×3 grid of ab pads below.
    // Slim waist, longer legs; limbs stay the coloured tubes.
    this.body = new THREE.Group();
    this.group.add(this.body);
    this.box(this.body, 0.4, 0.18, 0.2, SHORTS, 0, 1.06, 0); // shorts
    this.box(this.body, 0.38, 0.22, 0.17, STEEL, 0, 1.26, 0); // waist slab
    this.box(this.body, 0.52, 0.24, 0.2, STEEL, 0, 1.49, 0); // chest slab (V-taper)
    this.tube(this.body, 0.07, 0.1, COLLAR, 0, 1.65, 0); // neck
    const ABS = this.mat(0xd8dee4, 0.5, 0.3); // sculpted muscle plating
    for (const side of [-1, 1] as const) {
      this.box(this.body, 0.19, 0.12, 0.03, ABS, side * 0.11, 1.51, 0.105); // pec
    }
    for (let row = 0; row < 3; row++) {
      for (const side of [-1, 1] as const) {
        this.box(
          this.body,
          0.09,
          0.075,
          0.03,
          ABS,
          side * 0.06,
          1.36 - row * 0.085,
          0.09,
        ); // ab pad
      }
    }
    // Shoulder caps + arms. 🏋️ The arm boxes live in a per-side GROUP pivoted
    // at the shoulder so the coach routine can raise/swing them; group
    // rotation (0,0,0) is the sculpted tray-carry pose (same offsets as the
    // old body-attached boxes, rebased to the shoulder pivot).
    for (const side of [-1, 1] as const) {
      this.box(this.body, 0.14, 0.14, 0.16, COLLAR, side * 0.3, 1.52, 0);
      const arm = new THREE.Group();
      arm.position.set(side * 0.31, 1.5, 0);
      this.body.add(arm);
      const upper = this.tube(arm, 0.06, 0.3, ARM, 0, -0.16, 0.1);
      upper.rotation.x = -0.55; // upper arm angled forward-down
      const fore = this.tube(arm, 0.055, 0.28, ARM, side * -0.04, -0.33, 0.28);
      fore.rotation.x = -1.35; // forearm reaching level to the tray
      this.tube(arm, 0.05, 0.08, JOINT, side * -0.07, -0.33, 0.4); // hand
      if (side < 0) this.armL = arm;
      else this.armR = arm;
    }
    // Backpack power unit — snug against the flat back.
    this.box(this.body, 0.34, 0.32, 0.12, JOINT, 0, 1.42, -0.16);
    this.box(
      this.body,
      0.1,
      0.14,
      0.04,
      this.mat(0xf5f7f9, 0.6, 0.1),
      0.08,
      1.46,
      -0.24,
    );
    // Head: 🏋️ a clear, distinct head above the neck — compact flat-faced
    // block (matches the slab torso), front sunglasses visor, side bolts and
    // the antenna.
    this.box(this.body, 0.3, 0.26, 0.26, STEEL, 0, 1.83, 0);
    this.box(this.body, 0.28, 0.08, 0.05, VISOR, 0, 1.86, 0.13); // 😎 visor
    this.box(this.body, 0.1, 0.03, 0.02, JOINT, 0, 1.76, 0.135); // mouth slit
    for (const side of [-1, 1] as const) {
      this.tube(this.body, 0.045, 0.06, JOINT, side * 0.17, 1.83, 0).rotation.z =
        Math.PI / 2; // ear bolts
    }
    this.tube(this.body, 0.015, 0.12, JOINT, 0.1, 2.02, -0.05); // antenna
    const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), STEEL);
    antennaTip.position.set(0.1, 2.09, -0.05);
    antennaTip.castShadow = true;
    this.body.add(antennaTip);

    // Tray held out front, with four cocktails.
    this.tray = new THREE.Group();
    this.tray.position.set(0, 1.22, 0.46);
    this.body.add(this.tray);
    this.box(this.tray, 0.6, 0.035, 0.38, WOODY, 0, 0, 0);
    this.box(this.tray, 0.6, 0.05, 0.03, WOODY, 0, 0.02, 0.185);
    this.box(this.tray, 0.6, 0.05, 0.03, WOODY, 0, 0.02, -0.185);
    const slots: Array<[number, number]> = [
      [-0.2, -0.08],
      [0.02, -0.08],
      [-0.09, 0.09],
      [0.16, 0.09],
    ];
    DRINKS.forEach((spec, i) => {
      const drink = new THREE.Group();
      drink.name = `waiter-drink-${i}`;
      const glass = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.038, 0.16, 8),
        this.mat(spec.body, 0.35, 0.02),
      );
      glass.position.y = 0.1;
      glass.castShadow = true;
      drink.add(glass);
      const straw = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.008, 0.14, 5),
        this.mat(0xf2f5f7, 0.8, 0),
      );
      straw.position.set(0.02, 0.22, 0);
      straw.rotation.z = -0.3;
      drink.add(straw);
      const garnish = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 7, 5),
        this.mat(spec.garnish, 0.7, 0.02),
      );
      garnish.position.set(-0.045, 0.185, 0);
      drink.add(garnish);
      const [dx, dz] = slots[i];
      drink.position.set(dx, 0.02, dz);
      this.tray.add(drink);
      this.drinks.push({
        group: drink,
        home: drink.position.clone(),
        consumed: false,
        refillAt: 0,
      });
    });
  }

  // ── Per-frame update ───────────────────────────────────────────────────────

  /** `player` is null while the local player is not active in the room. */
  update(dt: number, player: Player | null): void {
    this.time += dt;
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.smalltalkCooldown > 0)
      this.smalltalkCooldown = Math.max(0, this.smalltalkCooldown - dt);
    this.refill();

    // One player↔bot distance per frame — shared by small talk and the
    // dock-wake check below (foxDistance is allocation-free).
    const foxDist = player ? this.foxDistance(player) : Infinity;
    this.maybeSmalltalk(foxDist);

    if (this.servePhase !== "NONE") {
      this.tray.visible = true; // 🍹 the tray only shows while serving drinks
      this.updateServe(dt, player);
      return;
    }

    // 🤖 STOP/START (owner request): a PARKED bot walks back to its dock and
    // stands on it, OFF — overriding routine + croupier duty. (A mid-serve above
    // finishes first, then the next frame parks.)
    if (this.parked) {
      this.tray.visible = false;
      this.activity = "DOCK";
      if (this.dockTarget) this.updateDock(dt);
      else this.idlePose();
      return;
    }

    // 🎰🤖 #77 Phase B: croupier duty takes priority. With a wheel-head post set
    // (the room has a roulette table), the bot walks to the head of the wheel and
    // stands the table — no patrol, no dock, no serving.
    if (this.croupierPost) {
      this.tray.visible = false; // a croupier carries no drink tray
      this.activity = "CROUPIER";
      this.updateCroupierPost(dt);
      return;
    }

    // 🏋️ #77: a 'coach' robot runs its class — never serves or croupiers
    // (world's croupier eligibility skips it too).
    if (this.routine === "coach") {
      this.tray.visible = false;
      this.updateCoach(dt);
      return;
    }

    // 🤖 #77C s4: a 'custom' robot runs its owner-authored step loop (walk / say /
    // wait) — never serves or croupiers.
    if (this.routine === "custom") {
      this.tray.visible = false;
      this.updateScript(dt);
      return;
    }

    // 🤖 #77C s3: OFF-DUTY per routine → wait at the dock. An 'idle' robot always
    // waits; a 'croupier' robot waits whenever it has no wheel to run. Only a
    // 'serve' robot falls through to the patrol/serve behaviour below.
    if (this.routine === "idle" || this.routine === "croupier") {
      this.tray.visible = false;
      this.activity = "DOCK";
      if (this.dockTarget) this.updateDock(dt);
      else this.idlePose();
      return;
    }

    // 🔌 #77 Phase A: idle→dock. A fox within range (or no dock at all) keeps
    // the bot awake on patrol/serve; otherwise idle accrues and, past the
    // threshold, the bot heads to its charging dock and holds a charge pose.
    const foxNear = foxDist < DOCK_WAKE_RANGE;
    if (foxNear || !this.dockTarget) {
      this.idleTimer = 0;
      this.activity = "PATROL";
    } else {
      this.idleTimer += dt;
      if (this.idleTimer > DOCK_AFTER_SECS) this.activity = "DOCK";
    }

    if (this.activity === "DOCK") {
      this.tray.visible = false; // docked/charging — tray stowed
      this.updateDock(dt);
    } else {
      this.tray.visible = true; // patrolling/serve-ready — tray out
      this.updatePatrol(dt);
      if (player) this.maybeBeginServe(player);
    }
  }

  /** 🗨️ #77: greet a fox the moment it steps into range — edge-triggered on
   *  the far→near transition (so standing beside the bot doesn't re-fire)
   *  with a per-bot cooldown. Runs every frame so `foxWasNear` tracks reality
   *  on every routine path; the speak itself is gated on an EXPLICIT idle
   *  predicate — only a 'serve' bot that isn't mid-serve, parked or standing
   *  a table makes small talk. */
  private maybeSmalltalk(foxDist: number): void {
    const near = foxDist < SMALLTALK_RANGE;
    const entered = near && !this.foxWasNear;
    this.foxWasNear = near;
    if (!entered || this.smalltalkCooldown > 0) return;
    if (
      this.servePhase !== "NONE" ||
      this.parked ||
      this.croupierPost ||
      (this.routine !== "serve" && this.routine !== "coach")
    ) {
      return;
    }
    // 🏋️ A coach invites you to the class; a server makes small talk.
    // 🔇 A line dropped by the room-entry quiet window burns nothing: re-arm
    // the edge so the greeting retries — it lands right as the window opens
    // (the "speak ~1 s after entering" behaviour, owner request).
    const delivered = this.sayRandom(
      this.routine === "coach"
        ? COACH_INVITES
        : this.activity === "DOCK"
          ? SMALLTALK_CHARGING
          : SMALLTALK_PATROL,
    );
    if (delivered) this.smalltalkCooldown = SMALLTALK_COOLDOWN_SECS;
    else this.foxWasNear = false;
  }

  /** One line through the world's bubble+voice seam. Returns whether it was
   *  actually delivered (false ⇒ the room-entry quiet window dropped it). */
  private say(text: string): boolean {
    if (!this.sayHandler) return false;
    const p = this.group.position;
    return this.sayHandler(text, p.x, p.z);
  }

  /** One random line from `pool`. */
  private sayRandom(pool: readonly string[]): boolean {
    return this.say(pool[Math.floor(Math.random() * pool.length)]);
  }

  /** 🏋️ The coach's stage: the open floor nearest the ROOM CENTRE (owner
   *  request — the class happens mid-room, not beside the charger). Ring-
   *  search the walkable grid outward from (0,0); computed once per class
   *  (reset when the routine changes) so a furniture edit mid-class doesn't
   *  teleport the stage. */
  private findCoachStage(): { x: number; z: number } {
    return (
      nearestWalkableCell(0, 0, 12) ?? {
        x: this.group.position.x,
        z: this.group.position.z,
      }
    );
  }

  /** 🏋️ Walk to the stage (room centre), then loop the class: announce a
   *  move → demonstrate its reps → rest → next move. Call-outs ride the say
   *  seam, so they bubble AND speak. */
  private updateCoach(dt: number): void {
    if (!this.coachStage) this.coachStage = this.findCoachStage();
    if (!this.walkTo(dt, this.coachStage.x, this.coachStage.z, 0.15)) {
      this.resetExercisePose();
      return;
    }
    // 🎥 The class is staged for the SCREEN: face the camera when the world
    // provides the stage yaw (workout-video framing), else fall back to the
    // dock's room-facing.
    const face = this.stageYaw ?? this.dockTarget?.faceAngle;
    if (face !== undefined) this.turnToward(face, dt);

    this.coachTimer += dt;
    const move = COACH_MOVES[this.coachMove];
    switch (this.coachPhase) {
      case "announce":
        if (!this.coachSaid) {
          this.coachSaid = true;
          this.say(move.call);
        }
        this.idlePose();
        if (this.coachTimer >= COACH_ANNOUNCE_SECS) this.setCoachPhase("reps");
        break;
      case "reps": {
        // Count the rep as it begins — "One!" … "Eight!" (owner request).
        if (!this.coachSaid) {
          this.coachSaid = true;
          this.say(COUNT_WORDS[Math.min(this.coachRep, COUNT_WORDS.length - 1)]);
        }
        const t = Math.min(1, this.coachTimer / move.repSecs);
        this.animateMove(move.name, curveFor(move.name, t));
        if (t >= 1) {
          this.coachRep += 1;
          this.coachTimer = 0;
          this.coachSaid = false; // re-arm the count for the next rep
          if (this.coachRep >= move.reps) this.setCoachPhase("rest");
        }
        break;
      }
      case "rest":
        if (!this.coachSaid) {
          this.coachSaid = true;
          this.resetExercisePose();
          this.sayRandom(COACH_REST_LINES);
        }
        this.idlePose();
        if (this.coachTimer >= COACH_REST_SECS) {
          this.coachMove = (this.coachMove + 1) % COACH_MOVES.length;
          this.setCoachPhase("announce");
        }
        break;
    }
  }

  /** 🎥 Camera-facing yaw for the coach's class (set per frame by the world;
   *  null = face the dock's room direction). */
  public setStageYaw(yaw: number | null): void {
    this.stageYaw = yaw;
  }

  /** 🏋️ Whether this bot is running the coach routine (drives stage facing
   *  and the follow-the-coach slot in the world). */
  public isCoaching(): boolean {
    return this.routine === "coach";
  }

  /** 🏋️ The fox follower's mirror of the CURRENT rep (#77 follow-the-coach)
   *  — non-null only mid-reps. Chibi-scaled amplitudes live HERE, beside
   *  animateMove's robot numbers, so retuning a move can't desync the two
   *  rigs. The world adds only follower policy (who mirrors, when). */
  public getFollowerPose(): WorkoutPose | null {
    if (this.routine !== "coach" || this.coachPhase !== "reps") return null;
    const move = COACH_MOVES[this.coachMove];
    const t = Math.min(1, this.coachTimer / move.repSecs);
    const k = curveFor(move.name, t);
    if (move.name === "squat") {
      // Deep sink + arms straight out; no torso lean — on the big-headed
      // chibi fox a lean reads as a bow, not a rep (owner feedback).
      return { dip: -0.18 * k, armLX: -1.4 * k, armRX: -1.4 * k, armZ: 0, legZ: 0 };
    }
    if (move.name === "jack") {
      return { dip: 0.05 * k, armLX: 0, armRX: 0, armZ: 2.1 * k, legZ: 0.3 * k };
    }
    // Lunge — same split/arm-drive pattern as the robot's rep.
    const frontIsL = this.coachRep % 2 === 0;
    return {
      dip: -0.14 * k,
      armZ: 0,
      legZ: 0,
      legLX: (frontIsL ? -0.85 : 0.55) * k,
      legRX: (frontIsL ? 0.55 : -0.85) * k,
      armLX: (frontIsL ? 0.45 : -0.9) * k,
      armRX: (frontIsL ? -0.9 : 0.45) * k,
    };
  }

  /** 🏋️ The class's line-up spots — one either side of the coach, spaced
   *  along the stage (perpendicular to the camera), formation owned by the
   *  class itself. Callers filter for walkability/pathing. */
  public getFollowerSlots(): Array<{ x: number; z: number }> {
    const yaw = this.stageYaw ?? 0;
    const p = this.group.position;
    return [1, -1].map((side) => ({
      x: p.x + Math.sin(yaw + side * (Math.PI / 2)) * 1.9,
      z: p.z + Math.cos(yaw + side * (Math.PI / 2)) * 1.9,
    }));
  }

  private setCoachPhase(phase: "announce" | "reps" | "rest"): void {
    this.coachPhase = phase;
    this.coachTimer = 0;
    this.coachSaid = false;
    if (phase === "reps") this.coachRep = 0;
  }

  /** One rep of `move`, `t` ∈ [0,1] through it. Squat/lunge ride holdCurve
   *  (down–hold–up, like a real rep); jacks ride a bouncy half-sine. Every
   *  curve returns to 0, so each rep starts and ends at the neutral stance. */
  private animateMove(name: (typeof COACH_MOVES)[number]["name"], t: number): void {
    if (name === "squat") {
      // 🦵 A HUMAN squat: thighs fold forward, shins counter-rotate to stay
      // upright, and hips + torso drop by the thigh-fold shortening so the
      // feet stay planted. Arms come straight out for counterbalance.
      const k = holdCurve(t);
      const bend = 1.05 * k; // thigh fold angle
      const drop = 0.48 * (1 - Math.cos(bend)); // fold shortening ⇒ hip drop
      this.legL.rotation.x = -bend;
      this.legR.rotation.x = -bend;
      this.shinL.rotation.x = bend;
      this.shinR.rotation.x = bend;
      this.legL.position.y = HIP_Y - drop;
      this.legR.position.y = HIP_Y - drop;
      this.body.position.y = -drop;
      this.armL.rotation.x = -1.4 * k;
      this.armR.rotation.x = -1.4 * k;
    } else if (name === "jack") {
      const k = Math.sin(Math.PI * t);
      this.body.position.y = 0.08 * k; // the hop
      this.legL.rotation.z = -0.4 * k; // legs splay outward
      this.legR.rotation.z = 0.4 * k;
      this.armL.rotation.z = -2.4 * k; // arms sweep sideways overhead
      this.armR.rotation.z = 2.4 * k;
    } else {
      // lunge — alternate the leading leg each rep, held low at the bottom,
      // with a bent front knee and a runner's opposite-arm drive.
      const k = holdCurve(t);
      const frontIsL = this.coachRep % 2 === 0;
      const front = frontIsL ? this.legL : this.legR;
      const back = frontIsL ? this.legR : this.legL;
      const frontShin = frontIsL ? this.shinL : this.shinR;
      front.rotation.x = -0.85 * k;
      frontShin.rotation.x = 0.55 * k; // 🦵 front knee bends into the step
      back.rotation.x = 0.55 * k;
      const driveArm = frontIsL ? this.armR : this.armL;
      const trailArm = frontIsL ? this.armL : this.armR;
      driveArm.rotation.x = -0.9 * k;
      trailArm.rotation.x = 0.45 * k;
      this.body.position.y = -0.18 * k;
    }
  }

  /** Clear every joint an exercise touches (walk/idle manage leg X). */
  private resetExercisePose(): void {
    this.armL.rotation.set(0, 0, 0);
    this.armR.rotation.set(0, 0, 0);
    this.legL.rotation.z = 0;
    this.legR.rotation.z = 0;
    this.shinL.rotation.x = 0;
    this.shinR.rotation.x = 0;
    this.legL.position.y = HIP_Y;
    this.legR.position.y = HIP_Y;
    this.body.position.y = 0;
    this.body.rotation.x = 0;
  }

  /** 🔌 Point the bot at a charging dock (world pos + facing). The world calls
   *  this after locating a 'charging-dock' item; a room without one stays on
   *  pure patrol. Passing null clears the dock and returns the bot to patrol. */
  public setDock(dock: { x: number; z: number; faceAngle: number } | null): void {
    this.dockTarget = dock;
    if (!dock && this.activity === "DOCK") {
      this.activity = "PATROL";
      this.idleTimer = 0;
    }
  }

  /** 🤖 #77C s3: set the owner-programmed routine (from the dock's console). */
  public setRoutine(routine: RobotRoutine): void {
    if (routine !== this.routine) {
      // 🏋️ Leaving coach mid-rep must not strand raised arms / splayed legs;
      // entering restarts the class from the first move's announce, with the
      // stage re-picked (furniture may have moved since the last class).
      this.resetExercisePose();
      this.setCoachPhase("announce");
      this.coachMove = 0;
      this.coachStage = null;
    }
    this.routine = routine;
  }

  /** 🤖 STOP/START: park the bot on its dock (true) or release it to its routine
   *  (false). Parking heads it to the dock immediately. */
  public setParked(parked: boolean): void {
    if (parked && !this.parked) this.activity = "DOCK";
    this.parked = parked;
  }

  /** 🤖 #77C s4: set the custom step list. Resets the loop only when the script
   *  actually changed, so a re-apply mid-loop doesn't restart it. */
  public setScript(steps: RobotStep[]): void {
    if (JSON.stringify(steps) === JSON.stringify(this.script)) return;
    this.script = steps;
    this.scriptIndex = 0;
    this.scriptTimer = 0;
    this.saidThisStep = false;
    this.path = [];
    this.pathGoalKey = "";
  }

  /** 🤖 #77C s4: the world provides the 'say' renderer (a bubble over the
   *  bot). It returns whether the line was delivered (false ⇒ quiet window). */
  public setSayHandler(fn: (text: string, x: number, z: number) => boolean): void {
    this.sayHandler = fn;
  }

  /** 🤖 #77C s4: advance the custom step loop (walk / say / wait). */
  private updateScript(dt: number): void {
    if (this.script.length === 0) {
      this.idlePose();
      return;
    }
    const step = this.script[this.scriptIndex % this.script.length];
    const advance = (): void => {
      this.scriptIndex = (this.scriptIndex + 1) % this.script.length;
      this.scriptTimer = 0;
      this.saidThisStep = false;
      this.path = [];
      this.pathGoalKey = "";
    };
    if (step.kind === "goto") {
      if (this.walkTo(dt, step.x, step.z, 0.15)) advance();
    } else if (step.kind === "say") {
      if (!this.saidThisStep) {
        this.saidThisStep = true;
        const p = this.group.position;
        this.sayHandler?.(step.text, p.x, p.z);
      }
      // Hold the pose briefly so the line is readable before the next step.
      this.idlePose();
      this.scriptTimer += dt;
      if (this.scriptTimer >= 2.5) advance();
    } else {
      // wait
      this.idlePose();
      this.scriptTimer += dt;
      if (this.scriptTimer >= step.secs) advance();
    }
  }

  /** Stand still (a dockless off-duty robot) — legs settled, a slow idle bob. */
  private idlePose(): void {
    this.legL.rotation.x = 0;
    this.legR.rotation.x = 0;
    this.body.position.y = Math.sin(this.time * 1.6) * 0.01;
  }

  /** 🎰🤖 Point the bot at a table's operator slot (world pos + facing) — the
   *  roulette wheel-head or the craps stickman. The world calls this after
   *  locating the table's reserved (`role`) stand; null clears it and returns
   *  the bot to patrol/dock. Croupier duty overrides both. */
  public setCroupierPost(
    post: { x: number; z: number; faceAngle: number } | null,
  ): void {
    this.croupierPost = post;
    if (!post && this.activity === "CROUPIER") {
      this.activity = "PATROL";
      this.idleTimer = 0;
    }
  }

  /** 🎰 Walk to the wheel-head, then stand it: face the wheel with a small
   *  "dealing" idle bob. */
  private updateCroupierPost(dt: number): void {
    const post = this.croupierPost;
    if (!post) return;
    if (this.walkTo(dt, post.x, post.z, 0.12)) {
      // Posted: face the wheel, legs settle, a small croupier idle.
      this.turnToward(post.faceAngle, dt);
      this.legL.rotation.x = 0;
      this.legR.rotation.x = 0;
      this.body.position.y = Math.sin(this.time * 2.2) * 0.02;
    }
  }

  /**
   * 🧭 #77C: walk toward (tx,tz) along an A*-routed path so the bot rounds
   * furniture / passes through door openings instead of clipping straight
   * through — the review's straight-line-through-tables gap. Recomputes the
   * route only when the goal changes; if no path exists (target behind a wall,
   * or the bot is off-grid) it falls back to a direct line so it never freezes.
   * Returns true once within `arriveDist`; animates the leg swing while moving.
   */
  private walkTo(dt: number, tx: number, tz: number, arriveDist: number): boolean {
    const pos = this.group.position;
    if (Math.hypot(tx - pos.x, tz - pos.z) < arriveDist) {
      this.path = [];
      return true;
    }
    const key = `${tx.toFixed(1)},${tz.toFixed(1)}`;
    if (key !== this.pathGoalKey) {
      this.pathGoalKey = key;
      this.path = findPath(
        worldToRow(pos.z),
        worldToCol(pos.x),
        worldToRow(tz),
        worldToCol(tx),
      );
    }
    // Drop waypoints already reached, then aim at the next one (or the goal
    // directly when the route is empty — the straight-line fallback).
    let target = this.path[0] ?? { x: tx, z: tz };
    let dx = target.x - pos.x;
    let dz = target.z - pos.z;
    let dist = Math.hypot(dx, dz);
    while (this.path.length > 0 && dist < CELL_SIZE * 0.5) {
      this.path.shift();
      target = this.path[0] ?? { x: tx, z: tz };
      dx = target.x - pos.x;
      dz = target.z - pos.z;
      dist = Math.hypot(dx, dz);
    }
    if (dist > 0.001) {
      const nx = dx / dist;
      const nz = dz / dist;
      this.turnToward(Math.atan2(nx, nz), dt);
      const step = Math.min(WALK_SPEED * dt, dist);
      pos.x += nx * step;
      pos.z += nz * step;
      const swing = Math.sin(this.time * 5.2) * 0.45;
      this.legL.rotation.x = swing;
      this.legR.rotation.x = -swing;
      this.body.position.y = Math.abs(Math.sin(this.time * 5.2)) * 0.025;
    }
    return false;
  }

  private foxDistance(player: Player): number {
    // Read the mesh position directly (getPosition() clones a Vector3, and
    // this runs per frame per bot).
    const p = player.mesh.position;
    return Math.hypot(p.x - this.group.position.x, p.z - this.group.position.z);
  }

  /** 🔌 Walk to the dock, then hold a charge pose (legs still, slow recharge
   *  bob, facing the dock). Yields the moment a fox comes near (handled in
   *  update, which flips activity back to PATROL). */
  private updateDock(dt: number): void {
    const dock = this.dockTarget;
    if (!dock) return;
    if (this.walkTo(dt, dock.x, dock.z, 0.12)) {
      // Charging: face the dock, legs settle, a slow recharge bob.
      this.turnToward(dock.faceAngle, dt);
      this.legL.rotation.x = 0;
      this.legR.rotation.x = 0;
      this.body.position.y = Math.sin(this.time * 1.6) * 0.012;
    }
  }

  private updatePatrol(dt: number): void {
    const [tx, tz] = this.patrol[this.patrolIndex];
    if (this.walkTo(dt, tx, tz, 0.1)) {
      // Reached this waypoint → ping-pong to the next.
      const next = this.patrolIndex + this.patrolDir;
      if (next < 0 || next >= this.patrol.length)
        this.patrolDir = -this.patrolDir as 1 | -1;
      this.patrolIndex += this.patrolDir;
    }
  }

  private turnToward(target: number, dt: number): void {
    let delta = target - this.heading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta <= -Math.PI) delta += Math.PI * 2;
    this.heading += delta * Math.min(1, TURN_RATE * dt);
    this.group.rotation.y = this.heading;
  }

  /** 迎面: fox close, on dry ground, and its heading points at the bot. */
  private maybeBeginServe(player: Player): void {
    if (this.cooldown > 0) return;
    if (player.isSwimming() || player.getSeatedSeatId() !== null) return;
    const drink = this.drinks.find((d) => !d.consumed);
    if (!drink) return; // tray empty — keep patrolling until a refill lands

    const pp = player.mesh.position;
    if (Math.abs(pp.y) > 0.05) return; // mid-bridge / mid-hop — not table-side
    const bp = this.group.position;
    const dx = bp.x - pp.x;
    const dz = bp.z - pp.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > SERVE_RANGE) return;
    const fa = player.getFacing();
    const dot = (Math.sin(fa) * dx + Math.cos(fa) * dz) / (dist || 1);
    if (dot < FACING_DOT) return;

    this.serveDrink = drink;
    this.servedPlayer = player;
    this.servePhase = "OFFER";
    this.serveTimer = 0;
    this.legL.rotation.x = 0;
    this.legR.rotation.x = 0;
    this.body.position.y = 0;
    // 🍹 One service line as the bot turns to offer (#77 "ask if a person
    // would like a drink").
    this.sayRandom(SERVE_LINES);
  }

  private updateServe(dt: number, player: Player | null): void {
    const drink = this.serveDrink;
    if (!player || !drink) {
      this.finishServe(true);
      return;
    }
    this.serveTimer += dt;
    const pp = player.mesh.position;
    const bp = this.group.position;
    const dx = pp.x - bp.x;
    const dz = pp.z - bp.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Keep facing the fox throughout the exchange.
    if (dist > 0.01) this.turnToward(Math.atan2(dx / dist, dz / dist), dt);

    // Fox wandered off before the sip — quietly put everything back.
    if (
      dist > ABORT_RANGE &&
      (this.servePhase === "OFFER" || this.servePhase === "FLY")
    ) {
      this.finishServe(true);
      return;
    }

    // 🐾 The drink rides IN the fox's right paw: the rig's drink-hold pose
    // raises the arm (0 = reaching forward, 1 = paw at the muzzle) and the
    // glass is glued to the paw's world position every frame — so the whole
    // pick-up-with-the-paw → lift-to-the-mouth → five-second sip reads on
    // the character itself, and a wandering fox carries its drink along.
    const paw = player.getPawWorldPos(this.pawTmp);

    switch (this.servePhase) {
      case "OFFER":
        if (this.serveTimer >= OFFER_TIME) {
          // Hand the drink to the scene so it can travel to the fox. attach()
          // keeps the world transform — zero the inherited rotation so the
          // glass flies upright, and remember the inherited ×ROBOT_SCALE.
          drink.group.getWorldPosition(this.flyFrom);
          this.scene.attach(drink.group);
          drink.group.rotation.set(0, 0, 0);
          this.flyScale = drink.group.scale.x;
          player.setDrinkHold(0); // 🐾 fox reaches its paw out for the glass
          this.servePhase = "FLY";
          this.serveTimer = 0;
        }
        break;
      case "FLY": {
        // Tray → the fox's outstretched paw.
        const t = Math.min(1, this.serveTimer / FLY_TIME);
        const s = t * t * (3 - 2 * t);
        drink.group.position.lerpVectors(this.flyFrom, paw, s);
        drink.group.position.y += DRINK_ARC_LIFT * 4 * t * (1 - t);
        if (t >= 1) {
          this.servePhase = "SIP";
          this.serveTimer = 0;
        }
        break;
      }
      case "SIP": {
        // Five seconds in the paw: the ARM lifts glass-to-muzzle SIP_CYCLES
        // times (the rig converges to the drink-hold pose), tipping the glass
        // back while it is up, lowering it between sips.
        const t = Math.min(1, this.serveTimer / SIP_TIME);
        const raise = 0.5 - 0.5 * Math.cos(t * Math.PI * 2 * SIP_CYCLES);
        player.setDrinkHold(raise);
        drink.group.position.copy(paw);
        drink.group.position.y += 0.06; // glass base sits on the paw pad
        drink.group.rotation.z = 0.8 * raise; // tips back while at the muzzle
        if (t >= 1) {
          this.servePhase = "GULP";
          this.serveTimer = 0;
        }
        break;
      }
      case "GULP": {
        // Last swallow at the muzzle — the empty glass shrinks away.
        const t = Math.min(1, this.serveTimer / GULP_TIME);
        player.setDrinkHold(1);
        drink.group.position.copy(paw);
        drink.group.position.y += 0.06;
        drink.group.scale.setScalar(Math.max(0.001, this.flyScale * (1 - t)));
        if (t >= 1) this.finishServe(false);
        break;
      }
      default:
        this.finishServe(true);
    }
  }

  /** aborted=true puts the drink back on the tray; false marks it drunk. */
  private finishServe(aborted: boolean): void {
    // 🐾 Release the fox's drink-hold arm pose (normal animation resumes).
    this.servedPlayer?.setDrinkHold(null);
    this.servedPlayer = null;
    const drink = this.serveDrink;
    if (drink) {
      if (aborted) {
        this.restock(drink);
      } else {
        drink.consumed = true;
        drink.refillAt = this.time + REFILL_TIME;
        drink.group.visible = false;
        this.tray.add(drink.group); // park it (hidden) back in the tray
        drink.group.position.copy(drink.home);
        drink.group.rotation.set(0, 0, 0);
        drink.group.scale.setScalar(1);
      }
    }
    this.serveDrink = null;
    this.servePhase = "NONE";
    this.serveTimer = 0;
    this.cooldown = SERVE_COOLDOWN;
  }

  private restock(drink: DrinkSlot): void {
    this.tray.add(drink.group);
    drink.group.position.copy(drink.home);
    drink.group.rotation.set(0, 0, 0);
    drink.group.scale.setScalar(1);
    drink.group.visible = true;
    drink.consumed = false;
  }

  private refill(): void {
    for (const drink of this.drinks) {
      if (drink.consumed && this.time >= drink.refillAt) this.restock(drink);
    }
  }

  /** Remove from the scene and free GPU resources (room swap). */
  dispose(): void {
    // Pull any mid-flight drink back under the tray first so the traverse
    // below reaches (and disposes) every mesh.
    for (const drink of this.drinks) {
      if (drink.group.parent !== this.tray) this.restock(drink);
    }
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
  }
}
