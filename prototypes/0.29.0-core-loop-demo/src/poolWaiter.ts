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
import { CELL_SIZE, findPath, worldToCol, worldToRow } from "./pathfinding";

const WALK_SPEED = 1.15; // leisurely service pace (fox walks 2.8)
const TURN_RATE = 9; // exponential turn smoothing factor
/** Whole-bot scale: native build is 1.8 tall; ×1.4 ≈ 2.5 = 75% of the fox's
 *  measured 3.33 bbox height. The tray + drinks ride the same scale. */
const ROBOT_SCALE = 1.4;
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

  private build(): void {
    // ⬛⬜ Monochrome livery: white chassis panels, black joints/servos,
    // black polo with white collar + badge, white shorts, black visor.
    const STEEL = this.mat(0xf1f3f5, 0.55, 0.35); // white chassis
    const JOINT = this.mat(0x191c20, 0.6, 0.4); // black joints
    const SHIRT = this.mat(0x24272c, 0.85, 0.02); // black polo
    const COLLAR = this.mat(0xf1f3f5, 0.85, 0.02); // white collar
    const SHORTS = this.mat(0xe8ebee, 0.8, 0.08); // white shorts
    const VISOR = this.mat(0x14181c, 0.35, 0.1); // sunglasses band
    const WOODY = this.mat(0x8a5a2e, 0.8, 0.05); // tray timber

    // Legs — hip-pivoted groups so they can swing while walking.
    for (const side of [-1, 1] as const) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.15, 0.68, 0);
      this.box(leg, 0.17, 0.34, 0.2, STEEL, 0, -0.17, 0); // thigh
      this.box(leg, 0.1, 0.1, 0.12, JOINT, 0, -0.36, 0); // knee servo
      this.box(leg, 0.15, 0.26, 0.17, STEEL, 0, -0.5, 0); // shin
      this.box(leg, 0.18, 0.09, 0.3, JOINT, 0, -0.645, 0.05); // foot
      this.group.add(leg);
      if (side < 0) this.legL = leg;
      else this.legR = leg;
    }

    // Body group (shorts → torso → head) — bobs as one while walking.
    this.body = new THREE.Group();
    this.group.add(this.body);
    this.box(this.body, 0.48, 0.24, 0.3, SHORTS, 0, 0.8, 0);
    this.box(this.body, 0.52, 0.42, 0.33, SHIRT, 0, 1.11, 0); // polo torso
    this.box(this.body, 0.54, 0.07, 0.35, COLLAR, 0, 1.3, 0); // collar band
    // Name badge + logo chip on the chest (white on the black polo).
    this.box(
      this.body,
      0.12,
      0.09,
      0.02,
      this.mat(0xf2f5f7, 0.9, 0),
      -0.15,
      1.19,
      0.17,
    );
    this.box(
      this.body,
      0.09,
      0.07,
      0.02,
      this.mat(0x111417, 0.9, 0),
      0.16,
      1.19,
      0.17,
    );
    // Shoulder caps + arms, permanently posed to carry the tray out front.
    for (const side of [-1, 1] as const) {
      this.box(this.body, 0.14, 0.14, 0.16, COLLAR, side * 0.33, 1.26, 0);
      const upper = this.box(
        this.body,
        0.11,
        0.3,
        0.13,
        STEEL,
        side * 0.34,
        1.1,
        0.1,
      );
      upper.rotation.x = -0.55; // upper arm angled forward-down
      const fore = this.box(
        this.body,
        0.1,
        0.28,
        0.11,
        JOINT,
        side * 0.3,
        0.93,
        0.28,
      );
      fore.rotation.x = -1.35; // forearm reaching level to the tray
      this.box(this.body, 0.09, 0.08, 0.1, STEEL, side * 0.27, 0.93, 0.4); // hand
    }
    // Backpack power unit.
    this.box(this.body, 0.36, 0.4, 0.14, JOINT, 0, 1.1, -0.22);
    this.box(
      this.body,
      0.1,
      0.14,
      0.04,
      this.mat(0xf5f7f9, 0.6, 0.1),
      0.08,
      1.16,
      -0.3,
    );
    // Head: grey block, black sunglasses visor, side bolts, antenna.
    this.box(this.body, 0.32, 0.28, 0.3, STEEL, 0, 1.52, 0);
    this.box(this.body, 0.3, 0.08, 0.06, VISOR, 0, 1.55, 0.15); // 😎
    this.box(this.body, 0.1, 0.03, 0.02, JOINT, 0, 1.44, 0.16); // mouth slit
    for (const side of [-1, 1] as const) {
      this.box(this.body, 0.05, 0.1, 0.1, JOINT, side * 0.185, 1.52, 0);
    }
    this.box(this.body, 0.03, 0.12, 0.03, JOINT, 0.1, 1.71, -0.05); // antenna
    this.box(this.body, 0.06, 0.04, 0.06, STEEL, 0.1, 1.78, -0.05);

    // Tray held out front, with four cocktails.
    this.tray = new THREE.Group();
    this.tray.position.set(0, 0.98, 0.46);
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
    this.refill();

    if (this.servePhase !== "NONE") {
      this.tray.visible = true; // 🍹 the tray only shows while serving drinks
      this.updateServe(dt, player);
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

    // 🔌 #77 Phase A: idle→dock. A fox within range (or no dock at all) keeps
    // the bot awake on patrol/serve; otherwise idle accrues and, past the
    // threshold, the bot heads to its charging dock and holds a charge pose.
    const foxNear = !!player && this.foxDistance(player) < DOCK_WAKE_RANGE;
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

  /** 🎰🤖 Point the bot at a roulette wheel-head (world pos + facing). The world
   *  calls this after locating the table's `role:'wheelHead'` stand; null clears
   *  it and returns the bot to patrol/dock. Croupier duty overrides both. */
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
    const p = player.getPosition();
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
