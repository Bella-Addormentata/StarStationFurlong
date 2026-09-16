/**
 * 🤖 PoolWaiter — drink-service robot (here: the LOBBY's roaming waiter).
 *
 * A humanoid waiter android — synthetic face and torso, medium-brown hair,
 * white headset, red service outfit, and white-plated mechanical limbs —
 * patrols a fixed ping-pong route through the lobby aisles, carrying a wooden
 * tray of cocktails. When the fox walks up FACING it (close, heading roughly
 * at the bot), the bot stops, turns to the fox, and one drink flies from the
 * tray into the fox's paw, is sipped over five seconds, and drunk (shrinks
 * away). Drinks refill on a timer and a cooldown prevents back-to-back grabs.
 *
 * Purely LOCAL ambience (like the room's other decor pieces) — not networked:
 * every client simulates its own waiter, and only the local fox is served.
 * (Same bot as the pool room's waiter on the pool branch — the patrol route
 * is a constructor parameter so each room hands it its own floor plan.)
 */
import * as THREE from "three";
import type { Player } from "./player";
import {
  CELL_SIZE, findPath, worldToCol, worldToRow, nearestReachableCell,
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
/** Shoulder pivot height of the arm groups. */
const SHOULDER_Y = 1.6;
/** 🗨️ World-space anchor for the bot's overhead lines — just above the
 *  scaled hair and headset (≈2.9), co-owned with the geometry so a rebuild
 *  that changes the bot's height updates the bubbles with it. */
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
/** 💪 'arms' routine — the same class loop, ARMS ONLY, so a fox can follow
 *  it standing OR seated. Each move opens with a short how-to (`cues`,
 *  spoken one line at a time after the call) while the bot holds the
 *  move's start position. */
const ARM_MOVES = [
  {
    name: 'fly', call: 'First up: bent-arm chest fly!', reps: 8, repSecs: 2.4,
    cues: [
      'Elbows up at shoulder height, arms bent.',
      'Hug a big tree — squeeze your chest, then open.',
    ],
  },
  {
    name: 'press', call: 'Next: overhead press!', reps: 8, repSecs: 2.2,
    cues: [
      'Hands at your shoulders, elbows under your wrists.',
      'Push straight up, then bring them back down.',
    ],
  },
  {
    name: 'lateral', call: 'Next: lateral raises!', reps: 8, repSecs: 2.2,
    cues: [
      'Arms at your sides, elbows soft.',
      'Lift out to shoulder height — no higher.',
    ],
  },
  {
    name: 'kickback', call: 'Next: triceps kickbacks!', reps: 8, repSecs: 2.0,
    cues: [
      'Elbows tucked back by your ribs.',
      'Straighten your arms behind you and squeeze.',
    ],
  },
  {
    name: 'front', call: 'Last one: front raises!', reps: 8, repSecs: 2.2,
    cues: [
      'Arms straight down in front, core tight.',
      'Lift to shoulder height, then lower.',
    ],
  },
] as const;
type ClassMove = (typeof COACH_MOVES)[number] | (typeof ARM_MOVES)[number];
type MoveName = ClassMove['name'];
/** Routines that run the staged class (walk to centre, face the camera). */
function isClassRoutine(routine: RobotRoutine): boolean {
  return routine === 'coach' || routine === 'arms';
}
/** The spoken intro of a move: its call, then any how-to cues. */
function introLines(move: ClassMove): readonly string[] {
  return 'cues' in move ? [move.call, ...move.cues] : [move.call];
}
/** 'done' = the arm class ran its single round and said goodbye (it doesn't
 *  loop; STOP → START or a routine change runs it again). */
type CoachPhase = 'welcome' | 'announce' | 'reps' | 'rest' | 'done';
/** 💪 The arm class's upbeat opening, spoken line by line (waving, bouncing)
 *  before the first move — 'welcome' phase. */
const ARM_WELCOME: readonly string[] = [
  'Hi everyone! Join me for a relaxing arm workout — under 3 minutes!',
  'Stand or sit — standing is even better.',
  'Five moves, eight reps each, nice and slow. Let’s go!',
];
/** Hold after each welcome line. */
const ARM_WELCOME_SECS = 3.2;
/** 💪 The arm class's closing line, spoken once after its last set. */
const ARM_OUTRO = 'Thanks for joining me for this relaxing starter!';
/** Hold after each intro line of a move WITH cues (its last cue too, so the
 *  how-to stays readable before the count starts) — long enough to read. */
const COACH_CUE_SECS = 2.8;
/** 💪 The arm class's fixed facing off the camera (rad): 22.5° to the
 *  performers' OWN right (screen lower-left; owner request). The fox follows
 *  it exactly (Player.setFacing — not the 8-way snap). */
const ARM_CLASS_TURN = -Math.PI / 8;
/** 💪 Arm-move start position eases in over this long during the intro. */
const ARM_START_EASE_SECS = 0.6;
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
function curveFor(name: MoveName, t: number): number {
  return name === 'jack' ? Math.sin(Math.PI * t) : holdCurve(t);
}
const COACH_ANNOUNCE_SECS = 1.6; // beat between the call and the first rep
const COACH_REST_SECS = 4;
const COACH_REST_LINES: readonly string[] = [
  'And done — shake it out!',
  'Great set! Breathe…',
  'Nice form! Quick breather.',
];
/** 💪 The arm class's rest lines, one per rest IN ORDER (after moves 1–4) —
 *  never repeated, and the last one leads into the final move. */
const ARM_REST_LINES: readonly string[] = [
  'Nice work! Shake it out.',
  'Great set! Breathe.',
  'Good form! Quick rest.',
  'Almost there — one more!',
];
/** Proximity invite (the coach's flavour of small talk). */
const COACH_INVITES: readonly string[] = [
  'Join me for a set?',
  'Workout time — follow along if you like!',
  'A fit clone is a happy clone. Care to try?',
];
/** 💪 The arm coach's invites. */
const ARM_INVITES: readonly string[] = [
  'Join in — stand or sit!',
  'Arm workout — follow along!',
];
/** 💪 One arm-move pose on the robot rig, both sides mirrored: `a` swings the
 *  whole arm about the shoulder (X; + = back), `f` bends the elbow (X, in the
 *  arm's frame), `z` raises the arm out sideways (or, on a forward-held arm,
 *  rolls the elbow bend inward), and `y` then swings it open horizontally
 *  (the arm group's Euler order is YZX, so X → Z → Y apply in that order). Angles are measured from the
 *  rig's tray-carry rest: a = +0.59 hangs the upper arm straight down, and
 *  a + f = π/2 points the forearm straight down too. */
interface ArmPose { a: number; f: number; z: number; y?: number }
const ARM_HANG = 0.59;
const FORE_HANG = Math.PI / 2 - ARM_HANG;
function robotArmPose(name: MoveName, k: number): ArmPose | null {
  switch (name) {
    case 'fly': // "hug a tree": upper arms level, elbows bent 90° with the
      // forearms rolled inward; the arms sweep from wide open (k = 0) to
      // together in front of the chest (k = 1).
      return { a: -0.98, f: -0.59, z: Math.PI / 2, y: 1.35 * (1 - k) };
    case 'press': // upper arm forward-level → overhead; forearm stays vertical
      return { a: -0.98 - 1.57 * k, f: -0.59 + 1.57 * k, z: -0.25 }; // (−z flares a RAISED arm out)
    case 'lateral': // straight arms from the sides out to shoulder height
      return { a: ARM_HANG, f: FORE_HANG, z: 1.5 * k };
    case 'kickback': // upper arm back by the ribs; forearm extends behind
      return { a: 1.62, f: -0.05 + 1.03 * k, z: 0.12 };
    case 'front': // straight arms from hanging to forward-level
      return { a: ARM_HANG - 1.57 * k, f: FORE_HANG, z: 0 };
    default:
      return null;
  }
}
/** 💪 The chibi fox's mirror of an arm move (its arms have no elbow, so each
 *  move is the closest one-joint read). Legs and torso untouched — the same
 *  pose works standing or seated. */
function foxArmPose(name: MoveName, k: number): WorkoutPose | null {
  const arms = (x: number, z: number): WorkoutPose =>
    ({ dip: 0, armLX: x, armRX: x, armZ: z, legZ: 0, armsOnly: true });
  switch (name) {
    case 'fly': return arms(-1.5 * k, 1.5 * (1 - k)); // out wide → forward
    case 'press': return arms(0, 1.5 + 1.4 * k);
    case 'lateral': return arms(0, 1.55 * k);
    case 'kickback': return arms(0.45 + 0.55 * k, 0);
    case 'front': return arms(-1.5 * k, 0);
    default: return null;
  }
}

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
  /** 💪 Elbow-pivoted forearm subgroups (inside armL/armR) — chest flies/kickbacks. */
  private foreL!: THREE.Group;
  private foreR!: THREE.Group;
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
  /** 🍹🔇 The OFFER line landed (false ⇒ dropped by the quiet window; the
   *  exchange holds and retries until the bot has actually asked). */
  private offerSaid = false;
  /** Returns whether the line was actually delivered (the world drops lines
   *  during its room-entry quiet window) — droppers must not burn cooldowns. */
  private sayHandler: ((text: string, x: number, z: number) => boolean) | null = null;
  /** 🗨️ #77 small talk: greet once when a fox newly enters range, then hold off. */
  private smalltalkCooldown = 0;
  private foxWasNear = false;
  /** 🏋️ coach-routine state: which move, where in its announce/reps/rest
   *  cycle, and the once-per-phase say latch. */
  private coachMove = 0;
  private coachPhase: CoachPhase = 'announce';
  private coachTimer = 0;
  private coachRep = 0;
  private coachSaid = false;
  /** 💪 Which intro line (call, then cues) the announce phase is on. */
  private coachIntroLine = 0;
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
    emissive = 0x000000,
    emissiveIntensity = 0,
  ): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: rough,
      metalness: metal,
      emissive,
      emissiveIntensity,
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

  /** Rounded part (shoulder caps, chest plates, the head). Same contract. */
  private ball(
    parent: THREE.Object3D,
    radius: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /** Tapered segment (waist / hips / ribcage) — top and bottom radii differ. */
  private taper(
    parent: THREE.Object3D,
    rTop: number,
    rBottom: number,
    height: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(rTop, rBottom, height, 16),
      mat,
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private build(): void {
    // 💃 Android livery (owner reference: a humanoid android with a human
    // face and long medium-brown hair under white headphones, fully mechanical
    // white-plated limbs with dark joint segments — dressed in a fitted red
    // tennis dress with a short flared skirt). Same rig as before: hip-pivoted legs with knee shins,
    // shoulder-pivoted arms, one bobbing body group, the tray at the hands —
    // so every routine animates unchanged.
    const SKIN = this.mat(0xf0c2a2, 0.55, 0.05); // synthetic skin
    const PLATE = this.mat(0xf9fafc, 0.32, 0.2); // white limb plating (low metalness: no env map here)
    const MECH = this.mat(0x22262b, 0.55, 0.35); // dark joint mechanics
    const RED = this.mat(0xe0243a, 0.45, 0.1); // red tennis dress
    const TRIM = this.mat(0xffffff, 0.5, 0.05); // white tennis-dress piping
    const GLOW = this.mat(0x35e6ff, 0.4, 0.1, 0x35e6ff, 1.6); // cyan light strips
    const HAIR = this.mat(0x8a5a33, 0.6, 0.1); // long medium-brown hair
    const BROW = this.mat(0x5a381e, 0.7, 0.05); // brows a shade darker than the hair
    const EYE = this.mat(0xffffff, 0.3, 0.0);
    const IRIS = this.mat(0x3d8fe0, 0.3, 0.1, 0x1e5fb0, 0.35); // blue eyes
    const LIPS = this.mat(0xd9535e, 0.5, 0.05);
    const SOLE = this.mat(0x191c20, 0.6, 0.3); // boot soles
    const WOODY = this.mat(0x8a5a2e, 0.8, 0.05); // tray timber

    // Legs — hip-pivoted groups so they can swing while walking. Mechanical:
    // white plated thigh + shin, dark hip / knee / ankle joints, white
    // sneaker-boot on a dark lit sole.
    for (const side of [-1, 1] as const) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.13, HIP_Y, 0);
      this.tube(leg, 0.075, 0.1, MECH, 0, -0.05, 0); // hip joint
      this.tube(leg, 0.066, 0.4, PLATE, 0, -0.29, 0); // thigh plate
      this.tube(leg, 0.052, 0.06, MECH, 0, -0.475, 0); // knee joint
      // 🦵 Shin subgroup pivoted at the KNEE so a squat bends like a human
      // leg — thigh folds forward, shin counter-rotates to stay upright.
      const shin = new THREE.Group();
      shin.position.set(0, -0.48, 0);
      leg.add(shin);
      this.tube(shin, 0.056, 0.3, PLATE, 0, -0.17, 0); // shin plate
      this.tube(shin, 0.045, 0.06, MECH, 0, -0.35, 0); // ankle joint
      this.box(shin, 0.15, 0.08, 0.27, PLATE, 0, -0.44, 0.05); // sneaker
      this.box(shin, 0.155, 0.03, 0.28, SOLE, 0, -0.49, 0.05); // sole
      this.box(shin, 0.16, 0.012, 0.012, GLOW, 0, -0.478, 0.197); // toe light
      this.group.add(leg);
      if (side < 0) {
        this.legL = leg;
        this.shinL = shin;
      } else {
        this.legR = leg;
        this.shinR = shin;
      }
    }

    // Body group (hips → waist → chest → head) — bobs as one while walking.
    // 🎾 The torso keeps its HOURGLASS of tapered segments, now dressed in a
    // fitted sleeveless red tennis dress: the bodice hugs the flare / pinch /
    // ribcage, and a short flared skirt with a white hem hangs from the hips.
    // The skirt is an open cone on the body group, so walking and squat legs
    // swing inside it rather than dragging it along.
    this.body = new THREE.Group();
    this.group.add(this.body);
    for (const side of [-1, 1] as const) {
      this.ball(this.body, 0.08, RED, side * 0.15, 1.07, 0); // rounded hip
      this.ball(this.body, 0.088, RED, side * 0.072, 1.04, -0.065); // glute
    }
    const SKIRT = this.mat(0xe0243a, 0.45, 0.1); // open cone: seen from inside too
    SKIRT.side = THREE.DoubleSide;
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.27, 0.24, 16, 1, true), SKIRT);
    skirt.position.set(0, 1.0, 0); // flared skirt
    skirt.castShadow = true;
    this.body.add(skirt);
    this.taper(this.body, 0.268, 0.272, 0.025, TRIM, 0, 0.885, 0); // white hem
    this.taper(this.body, 0.105, 0.165, 0.14, RED, 0, 1.19, 0); // hip flare
    this.taper(this.body, 0.14, 0.1, 0.2, RED, 0, 1.36, 0); // waist pinch
    this.taper(this.body, 0.15, 0.14, 0.12, RED, 0, 1.52, 0); // ribcage
    for (const side of [-1, 1] as const) {
      this.ball(this.body, 0.085, RED, side * 0.088, 1.55, 0.075); // bust
      this.box(this.body, 0.035, 0.08, 0.1, RED, side * 0.12, 1.6, 0.0); // shoulder strap
      this.box(this.body, 0.01, 0.34, 0.012, TRIM, side * 0.145, 1.38, 0.0); // side piping
      this.ball(this.body, 0.06, MECH, side * 0.225, 1.62, 0); // shoulder joint
    }
    this.taper(this.body, 0.152, 0.152, 0.012, TRIM, 0, 1.585, 0); // neckline trim
    // A real neck: skin column on a dark mechanical collar, long enough to
    // show between the shoulders and the jaw.
    this.tube(this.body, 0.052, 0.03, MECH, 0, 1.6, 0); // collar
    this.tube(this.body, 0.046, 0.18, SKIN, 0, 1.7, 0); // neck
    // Shoulder-pivoted arms: white plated upper arm and forearm, dark elbow
    // joint and mechanical hand. Group rotation (0,0,0) is the tray-carry
    // pose (same pivot geometry as before, so the coach's raises still read).
    for (const side of [-1, 1] as const) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.27, SHOULDER_Y, 0);
      this.body.add(arm);
      arm.rotation.order = "YZX"; // swing (X), raise/roll (Z), then open (Y)
      const upper = this.tube(arm, 0.05, 0.3, PLATE, 0, -0.16, 0.1);
      upper.rotation.x = -0.55; // upper arm angled forward-down
      // 💪 Forearm + hand ride an ELBOW pivot so chest flies and kickbacks bend.
      const fore = new THREE.Group();
      fore.position.set(side * -0.02, -0.3, 0.2);
      arm.add(fore);
      const elbow = this.tube(fore, 0.048, 0.05, MECH, 0, 0, 0);
      elbow.rotation.x = -1.35;
      const foreTube = this.tube(fore, 0.052, 0.28, PLATE, side * -0.02, -0.03, 0.08);
      foreTube.rotation.x = -1.35; // forearm reaching level to the tray
      this.tube(fore, 0.04, 0.08, MECH, side * -0.05, -0.03, 0.2); // hand
      if (side < 0) {
        this.armL = arm;
        this.foreL = fore;
      } else {
        this.armR = arm;
        this.foreR = fore;
      }
    }
    // Slim power pack low on the back (the hair falls over the upper back).
    this.box(this.body, 0.24, 0.2, 0.08, PLATE, 0, 1.32, -0.15);
    this.box(this.body, 0.02, 0.14, 0.012, GLOW, 0, 1.32, -0.195);
    // Head (lifted to sit on the neck): round skin face with eyes, brows,
    // a small nose and lips; long medium-brown hair (cap, a tapering fall down the
    // back, two front strands set beside — not over — the neck); white
    // headphones — ear cups on the sides, a band over the crown.
    this.ball(this.body, 0.15, SKIN, 0, 1.93, 0);
    this.ball(this.body, 0.158, HAIR, 0, 1.97, -0.03); // hair cap
    this.box(this.body, 0.3, 0.26, 0.1, HAIR, 0, 1.85, -0.14); // hair fall — upper
    this.box(this.body, 0.22, 0.28, 0.08, HAIR, 0, 1.59, -0.15); // hair fall — tapering ends
    for (const side of [-1, 1] as const) {
      this.box(this.body, 0.055, 0.3, 0.1, HAIR, side * 0.165, 1.8, -0.02); // front strands
      this.ball(this.body, 0.024, EYE, side * 0.058, 1.95, 0.128); // eye
      this.ball(this.body, 0.014, IRIS, side * 0.058, 1.95, 0.147); // iris
      this.box(this.body, 0.06, 0.012, 0.02, BROW, side * 0.058, 1.995, 0.14); // brow
      const cup = this.tube(this.body, 0.07, 0.05, PLATE, side * 0.165, 1.94, 0.01); // ear cup
      cup.rotation.z = Math.PI / 2;
    }
    this.box(this.body, 0.022, 0.05, 0.03, SKIN, 0, 1.905, 0.15); // nose
    this.box(this.body, 0.35, 0.03, 0.03, PLATE, 0, 2.07, 0.12); // headband
    this.box(this.body, 0.07, 0.024, 0.02, LIPS, 0, 1.86, 0.145); // lips

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

    // 🏋️ #77: a 'coach' (or 💪 'arms') robot runs its class — never
    // serves or croupiers (world's croupier eligibility skips it too).
    if (isClassRoutine(this.routine)) {
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
      (this.routine !== "serve" && !isClassRoutine(this.routine))
    ) {
      return;
    }
    // 🏋️ A coach's own call-outs outrank the invite (one bubble anchor per
    // bot — a same-frame pair would clobber each other): invite only during
    // REST, once the rest line has had ~1.5 s on screen; until then keep the
    // edge armed so the invite lands in that window.
    if (
      isClassRoutine(this.routine) &&
      !(this.coachPhase === "rest" && this.coachSaid && this.coachTimer >= 1.5)
    ) {
      this.foxWasNear = false;
      return;
    }
    // 🏋️ A coach invites you to the class; a server makes small talk.
    // 🔇 A line dropped by the room-entry quiet window burns nothing: re-arm
    // the edge so the greeting retries — it lands right as the window opens
    // (the "speak ~1 s after entering" behaviour, owner request).
    const delivered = this.sayRandom(
      this.routine === "arms"
        ? ARM_INVITES
        : this.routine === "coach"
        ? COACH_INVITES
        : this.activity === "DOCK"
          ? SMALLTALK_CHARGING
          : SMALLTALK_PATROL,
    );
    if (delivered) this.smalltalkCooldown = SMALLTALK_COOLDOWN_SECS;
    else this.foxWasNear = false;
  }

  /** One line through the world's bubble+voice seam. Returns whether it was
   *  actually delivered (false ⇒ the room-entry quiet window dropped it, and
   *  the caller should retry). With no seam wired at all there is nothing to
   *  wait for, so that counts as delivered — callers never stall on it. */
  private say(text: string): boolean {
    if (!this.sayHandler) return true;
    const p = this.group.position;
    return this.sayHandler(text, p.x, p.z);
  }

  /** One random line from `pool`. */
  private sayRandom(pool: readonly string[]): boolean {
    return this.say(pool[Math.floor(Math.random() * pool.length)]);
  }

  /** 🏋️ The coach's stage: the open floor nearest the ROOM CENTRE (owner
   *  request — the class happens mid-room, not beside the charger) that the
   *  bot can actually WALK to — a merely walkable centre can sit behind a
   *  furniture partition, and walkTo's straight-line fallback would clip
   *  through it to a stage nobody can join. No reachable cell ⇒ the class is
   *  held right where the bot stands. Computed once per class (reset when
   *  the routine changes) so a furniture edit mid-class doesn't teleport it. */
  private findCoachStage(): { x: number; z: number } {
    const here = { x: this.group.position.x, z: this.group.position.z };
    return nearestReachableCell(0, 0, 12, here) ?? here;
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
    const moves = this.classMoves();
    const move = moves[this.coachMove % moves.length];
    // 💪 One class facing for the whole class (owner: no turning between
    // moves), shared with the fox so both look the same way — see
    // getClassFacing. A finished class keeps its last facing rather than
    // swinging back to the dock's.
    if (this.coachPhase !== "done") {
      const face = this.getClassFacing() ?? this.dockTarget?.faceAngle;
      if (face !== undefined) this.turnToward(face, dt);
    }

    // 🔇 Every phase opens with a line — the call, the rep's count ("One!" …
    // "Eight!", owner request), the rest quip — and the class WAITS for it:
    // the phase clock only runs once the line is delivered. So neither the
    // entry quiet window nor an empty room can silently eat a step of the
    // announce → eight counted reps → rest sequence; the class simply holds
    // at its next line until someone is there to hear it.
    if (!this.coachSaid) {
      this.coachSaid =
        this.coachPhase === "welcome"
          ? this.say(ARM_WELCOME[this.coachIntroLine] ?? ARM_WELCOME[0])
          : this.coachPhase === "announce"
          ? this.say(introLines(move)[this.coachIntroLine] ?? move.call)
          : this.coachPhase === "reps"
            ? this.say(COUNT_WORDS[Math.min(this.coachRep, COUNT_WORDS.length - 1)])
            : this.coachPhase === "done"
              ? this.say(ARM_OUTRO)
              : this.routine === "arms"
                ? this.say(ARM_REST_LINES[this.coachMove % ARM_REST_LINES.length])
                : this.sayRandom(COACH_REST_LINES);
      if (!this.coachSaid) {
        this.idlePose();
        return;
      }
    }
    this.coachTimer += dt;
    switch (this.coachPhase) {
      case "welcome": {
        // 💪 Happy, energetic hello: a big overhead wave with a bounce, and
        // both arms thrown up for the final "Let's go!".
        const cheer = this.coachIntroLine >= ARM_WELCOME.length - 1;
        this.animateWelcome(this.coachTimer, cheer);
        if (this.coachTimer >= ARM_WELCOME_SECS) {
          if (cheer) {
            this.setCoachPhase("announce");
          } else {
            this.coachIntroLine += 1;
            this.coachTimer = 0;
            this.coachSaid = false; // speak the next welcome line
          }
        }
        break;
      }
      case "announce": {
        // 💪 Arm moves demonstrate their START position while the how-to
        // plays (eased in, so the bot doesn't snap into it).
        if (robotArmPose(move.name, 0)) {
          const ease = Math.min(1, this.coachTimer / ARM_START_EASE_SECS);
          this.applyArmPose(move.name, 0, this.coachIntroLine === 0 ? ease : 1);
        } else {
          this.idlePose();
        }
        const lines = introLines(move);
        const last = this.coachIntroLine >= lines.length - 1;
        const hold = last && lines.length === 1 ? COACH_ANNOUNCE_SECS : COACH_CUE_SECS;
        if (this.coachTimer >= hold) {
          if (last) {
            this.setCoachPhase("reps");
          } else {
            this.coachIntroLine += 1;
            this.coachTimer = 0;
            this.coachSaid = false; // speak the next cue
          }
        }
        break;
      }
      case "reps": {
        const t = Math.min(1, this.coachTimer / move.repSecs);
        this.animateMove(move.name, t); // animateMove eases t itself
        if (t >= 1) {
          this.coachRep += 1;
          this.coachTimer = 0;
          this.coachSaid = false; // re-arm the count for the next rep
          if (this.coachRep >= move.reps) {
            // 💪 The arm class is ONE round: after the last set, say goodbye
            // and stop instead of looping back to the first move.
            const finished = this.routine === "arms" && this.coachMove >= moves.length - 1;
            this.setCoachPhase(finished ? "done" : "rest");
          }
        }
        break;
      }
      case "rest":
        this.idlePose();
        if (this.coachTimer >= COACH_REST_SECS) {
          this.coachMove = (this.coachMove + 1) % moves.length;
          this.setCoachPhase("announce");
        }
        break;
      case "done":
        this.idlePose(); // class over — stand on the stage, no more reps
        break;
    }
  }

  /** 🎥 Camera-facing yaw for the coach's class (set per frame by the world;
   *  null = face the dock's room direction). */
  public setStageYaw(yaw: number | null): void {
    this.stageYaw = yaw;
  }

  /** The move list of this bot's class routine. */
  private classMoves(): readonly ClassMove[] {
    return this.routine === "arms" ? ARM_MOVES : COACH_MOVES;
  }

  /** 🏋️ THE class facing — the bot and its followers both turn to it, so
   *  they look the same way. The stage yaw (camera), plus the arm class's
   *  slight turn (forward/back arm moves read flat from dead-on, since the
   *  camera looks DOWN at the stage). null = no stage (not coaching). */
  public getClassFacing(): number | null {
    if (this.stageYaw === null) return null;
    const turn = this.routine === "arms" ? ARM_CLASS_TURN : 0;
    return this.stageYaw + turn;
  }

  /** 🏋️ Whether this bot is running a class routine (drives stage facing
   *  and the follow-the-coach slot in the world). */
  public isCoaching(): boolean {
    // STOP ⇒ class is off; a finished arm class releases its followers too.
    return isClassRoutine(this.routine) && !this.parked && this.coachPhase !== "done";
  }

  /** 🏋️ The fox follower's mirror of the CURRENT rep (#77 follow-the-coach)
   *  — non-null only mid-reps. Chibi-scaled amplitudes live HERE, beside
   *  animateMove's robot numbers, so retuning a move can't desync the two
   *  rigs. The world adds only follower policy (who mirrors, when). */
  public getFollowerPose(): WorkoutPose | null {
    if (!isClassRoutine(this.routine)) return null;
    const moves = this.classMoves();
    const move = moves[this.coachMove % moves.length];
    // 💪 Arm moves: the fox takes the start position during the how-to too.
    if (this.coachPhase === "announce") return foxArmPose(move.name, 0);
    if (this.coachPhase !== "reps") return null;
    const t = Math.min(1, this.coachTimer / move.repSecs);
    const k = curveFor(move.name, t);
    const arms = foxArmPose(move.name, k);
    if (arms) return arms;
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

  private setCoachPhase(phase: CoachPhase): void {
    if (this.coachPhase === "welcome" && phase !== "welcome") {
      this.resetExercisePose(); // drop the wave before the first move's ease-in
    }
    this.coachPhase = phase;
    this.coachTimer = 0;
    this.coachSaid = false;
    this.coachIntroLine = 0;
    if (phase === "reps") this.coachRep = 0;
    if (phase === "rest" || phase === "done") this.resetExercisePose(); // once, on entry — not per frame
  }

  /** One rep of `move`, `t` ∈ [0,1] through it. Squat/lunge ride holdCurve
   *  (down–hold–up, like a real rep); jacks ride a bouncy half-sine. Every
   *  curve returns to 0, so each rep starts and ends at the neutral stance. */
  private animateMove(name: MoveName, t: number): void {
    const k = curveFor(name, t); // THE curve — shared with getFollowerPose
    if (robotArmPose(name, k)) {
      this.applyArmPose(name, k, 1);
    } else if (name === "squat") {
      // 🦵 A HUMAN squat: thighs fold forward, shins counter-rotate to stay
      // upright, and hips + torso drop by the thigh-fold shortening so the
      // feet stay planted. Arms come straight out for counterbalance.
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
      this.body.position.y = 0.08 * k; // the hop
      this.legL.rotation.z = -0.4 * k; // legs splay outward
      this.legR.rotation.z = 0.4 * k;
      this.armL.rotation.z = -2.4 * k; // arms sweep sideways overhead
      this.armR.rotation.z = 2.4 * k;
    } else if (name === "lunge") {
      // lunge — alternate the leading leg each rep, held low at the bottom,
      // with a bent front knee and a runner's opposite-arm drive.
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

  /** 💪 The welcome's body language at `secs` into a line: a bouncing,
   *  waving right arm — or, when `cheer`, both straight arms pumping overhead. */
  private animateWelcome(secs: number, cheer: boolean): void {
    const bounce = Math.abs(Math.sin(secs * 5));
    this.body.position.y = (cheer ? 0.06 : 0.03) * bounce;
    const up = 2.6 + (cheer ? 0.15 * bounce : 0.3 * Math.sin(secs * 8));
    this.armR.rotation.set(ARM_HANG, 0, up);
    this.foreR.rotation.x = FORE_HANG;
    if (cheer) {
      this.armL.rotation.set(ARM_HANG, 0, -(2.6 + 0.15 * bounce));
      this.foreL.rotation.x = FORE_HANG;
    } else {
      this.armL.rotation.set(0, 0, 0);
      this.foreL.rotation.x = 0;
    }
  }

  /** 💪 Put both arms in `name`'s pose at curve value `k`, scaled by `blend`
   *  (0 = tray-carry rest, 1 = full pose) for the intro's ease-in. */
  private applyArmPose(name: MoveName, k: number, blend: number): void {
    const p = robotArmPose(name, k);
    if (!p) return;
    const y = p.y ?? 0;
    this.armL.rotation.set(p.a * blend, -y * blend, -p.z * blend);
    this.armR.rotation.set(p.a * blend, y * blend, p.z * blend);
    this.foreL.rotation.x = p.f * blend;
    this.foreR.rotation.x = p.f * blend;
  }

  /** Clear every joint an exercise touches (walk/idle manage leg X). */
  private resetExercisePose(): void {
    this.armL.rotation.set(0, 0, 0);
    this.armR.rotation.set(0, 0, 0);
    this.foreL.rotation.x = 0;
    this.foreR.rotation.x = 0;
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
      // entering restarts the class from the top (💪 the arm class opens
      // with its welcome; the others at the first move's announce), with the
      // stage re-picked (furniture may have moved since the last class).
      this.resetExercisePose();
      this.setCoachPhase(routine === "arms" ? "welcome" : "announce");
      this.coachMove = 0;
      this.coachStage = null;
    }
    this.routine = routine;
  }

  /** 🤖 STOP/START: park the bot on its dock (true) or release it to its routine
   *  (false). Parking heads it to the dock immediately. */
  public setParked(parked: boolean): void {
    if (parked && !this.parked) {
      this.activity = "DOCK";
      // 🏋️ STOP can land mid-rep: clear the exercise joints so the bot doesn't
      // walk home with raised arms / splayed legs, and put the class back at
      // the first move's announce so START opens a fresh class.
      this.resetExercisePose();
      this.setCoachPhase(this.routine === "arms" ? "welcome" : "announce");
      this.coachMove = 0;
    }
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
      // 🔇 Retry until delivered (the entry quiet window drops lines; an empty
      // room drops them all) — the step holds here until its line lands, then
      // stays briefly so the line is readable before the next step. A bot
      // with no say seam counts as delivered (see say()), so it can't stall.
      if (!this.saidThisStep) this.saidThisStep = this.say(step.text);
      this.idlePose();
      if (this.saidThisStep) {
        this.scriptTimer += dt;
        if (this.scriptTimer >= 2.5) advance();
      }
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
    // would like a drink"). Retried from updateServe until delivered.
    this.offerSaid = this.sayRandom(SERVE_LINES);
  }

  private updateServe(dt: number, player: Player | null): void {
    const drink = this.serveDrink;
    if (!player || !drink) {
      this.finishServe(true);
      return;
    }
    // 🔇 No silent service: the OFFER clock only runs once the offer line
    // has been delivered (retry each frame until it is).
    if (this.servePhase === "OFFER" && !this.offerSaid) {
      this.offerSaid = this.sayRandom(SERVE_LINES);
      if (!this.offerSaid) return;
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
