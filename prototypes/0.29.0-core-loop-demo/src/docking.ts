/**
 * 📊 Door and Docking Ports System - Phase 2 Verification Feature
 *
 * Implements interactive docking ports (4 doors: North, South, East, West)
 * placed at the center of each room boundary wall. Includes:
 *   - Interactive control panels for room owners to manage pin codes, lock states, and target room connections.
 *   - Blinking notification light on the remote side's control panel.
 *   - Peer acceptance or rejection pairing flows (over WT / Yjs).
 *   - Lightly rendered "gray box" projections of connected adjacent chambers.
 */

import * as THREE from "three";
import { findDoor } from "./doors";
import type { DoorId } from "./doors";
import {
  physicalDoorPose, portForDoor, poseFromWall,
  DOOR_OPENING_WIDTH, DOOR_OPENING_HEIGHT, DOOR_POST_WIDTH,
  DOOR_LEAF_SHUT_OFFSET, DOOR_LEAF_OPEN_OFFSET,
  MIN_DOOR_GAP,
} from "./doorLayout";
// 🚪🧲 Which door of a KNOWN module a chain connects to — pure, tested.
import {
  candidateFarDoors, pickFacingDoor, moduleHalves, halfAlongWall,
  FACE_MATCH_TOLERANCE, WALL_YAW,
} from "./doorMatch";
import type { PhysicalDoorPose } from "./doorLayout";
import type { DoorLayoutRecord, DoorWall } from "./doorLayoutDoc";
import {
  DOOR_LABEL_MAX,
  sanitizeDoorLabel,
  readAllDoorLayout,
  writeDoorLabel,
  seedDoorLayoutDefaults,
  doorDisplayName,
  doorOrdinals,
  LEGACY_ID_WALL,
  writeDoorLayout,
  defaultDoorLayoutRecords,
  doorSetIsAuthoritative,
} from "./doorLayoutDoc";
import { validateDoorPlacement } from "./editMode";
import { ROOM_TEMPLATES } from "./roomTemplates";
import { getCameraYaw } from "./cameraRig";
import {
  projectionPoseForDoor,
  solveChain,
  foldChainEnd,
  ROOM_HALF,
  dockChain,
  isDockChain,
  DOCK_ENVELOPE_R,
  type ConnectorSegment,
} from "./adapter";
// ⚓ #163: the two-part docking adapter's shared rules (pure, tested).
import {
  classifyDockPort,
  isPortDoor,
  nextDockStep,
  gangwayPartRefusal,
  berthMemoryFrom,
  redockRecord,
  holdsOurRedock,
  farWriteMayStand,
  initiateChainRefusal,
  stampAfter,
  FAR_DOCK_REFUSAL,
  type DockPortState,
} from "./dockRules";
// 🛰️ Hull space: built chains register their swept boxes so exterior mounts
// can't be placed through a vestibule — and the assembly UI warns the other
// way when a chain would run through mounted equipment.
import { setChainBoxProvider, exteriorItemBoxes } from "./hull";
import { buildOctagonShell } from "./octagonHull";
import type { Box } from "./furniture";
import {
  armedPreset,
  presetSegments,
  partsCount,
  consumePart,
  refundPart,
  consumeForSegments,
  refundForSegments,
} from "./stationParts";
import {
  readDoorPolicy,
  writeDoorPolicy,
  passageLabel,
  readDoorRequests,
  readDoorGrants,
  writeDoorRequest,
  removeDoorRequest,
  writeDoorGrant,
  removeDoorGrant,
  hasDoorGrant,
  hasDoorRequest,
  type ConstructionMode,
  type DoorPolicyRecord,
} from "./doorPolicy";
import { getIdentityPub } from "./keypair";
import { getPlayerName } from "./identity";
import {
  deleteDoorPairing,
  writeDoorTombstone,
  writeDoorPairing,
  readDoor,
  transactDoorWrites,
} from "./doorsDoc";
import {
  doorLateralLimitForWall,
  clearDoorSlide,
  roomHalfExtents,
} from "./floorPlanDoc";
import { narrowAxisFor } from "./hullSection";
import {
  readAtlas, atlasLayout, moduleOverlapAt, roomIdFromSeed, compareAtlasRecency,
} from "./stationAtlas";

/** Advance a scalar toward a target by at most maxStep, landing exactly. */
function moveToward(current: number, target: number, maxStep: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

/** True for the 4 structural cardinal door ids (the docking berths). Free/genId
 *  doors are NOT cardinal — the cardinal-only pose helpers (physicalDoorPose /
 *  projectionPoseForDoor) must never be called with a free id. */
function isCardinalDoorId(id: string): id is DoorId {
  return id === "north" || id === "south" || id === "east" || id === "west";
}

export interface DockingState {
  doorId: string;
  locked: boolean;
  pinCode: string;
  connectedRoomAddress: string; // Target room URL seed
  pairingPending: boolean;
  pairedSuccessfully: boolean;
  /** #62 P2 (optional — absent on legacy pairings): the connection's assembled
   *  connector chain + far-side geometry, mirrored from the doors doc. P3
   *  renders the chain + poses the projection from these; P2 only stores/diffs. */
  segments?: ConnectorSegment[];
  /** May name a free `d:` door in the far room. */
  farDoor?: string;
  /** The far door's WALL — mirrored from the record; orients the projection. */
  farWall?: DoorWall;
  /** The far door's along-wall centre — shifts the far module sideways. */
  farLateral?: number;
  farYawDeg?: 0 | 45;
  /** #67 D2: this pairing is a TRANSIENT guest berth (docking adapter). */
  transient?: boolean;
  /** ⚓ #163: when this DOCK was made (mirrored from the record) — carried
   *  into every re-publish so a chain-geometry refresh never makes an old
   *  dock look newer than a later undock. */
  dockedAt?: number;
  /** ⚓ LOCAL only: the staged MATING half was paid for with an adapter part
   *  (+DOCK's second press), so clearing or a rejected pairing refunds it —
   *  until a pairing lands or PROVISION NEW MODULE spends it on the module it
   *  mints. The port itself is a door fitting, paid and refunded on its own —
   *  never through the working chain, which would count it twice. */
  dockMatePaid?: boolean;
  /** 🚪 The pending request on this door came IN from a peer (as opposed to
   *  our own INITIATE). An inbound request carries only an address — not
   *  which of the far module's doors it is from — so it can never prove it is
   *  the connection this door already has, and must not be allowed to touch a
   *  live pairing (review, round 6). */
  inboundRequest?: boolean;
}

/**
 * ⚓ #163: what DOCK / UNDOCK ask of the FAR room — its end of the same
 * connection. main.ts answers it (farDoorWrite.ts: a short background session
 * to that room's doc); docking.ts never imports main.ts.
 */
export type FarDockRequest =
  | {
      kind: "undock";
      /** The room THIS end is in — the room the operation started in, which
       *  an awaited far write may have outlived (absent: the active room). */
      nearRoomId?: string;
      farAddress: string;
      /** The far door, when this side's record names it. */
      farDoor?: string;
      nearDoorId: string;
      nearWall?: DoorWall;
      nearLateral?: number;
      undockedAt: number;
      /** Take back exactly ONE far dock — the one this client wrote with this
       *  stamp — and nothing else (redockPort's compensation when its own
       *  side changed under it). */
      onlyDockedAt?: number;
    }
  | {
      kind: "dock";
      nearRoomId?: string;
      /** The undock this DOCK re-makes the dock after (the berth memory's
       *  stamp): a far record still holding that released dock is a leftover
       *  to write over, never a newer claim (dockRules.farDockPatch). */
      replacesUndockedAt?: number;
      farAddress: string;
      farDoor: string;
      nearDoorId: string;
      nearWall?: DoorWall;
      nearLateral?: number;
      dockedAt: number;
    };

export type FarDockResult =
  | { ok: true; detail: "written" | "nothing-to-undo" }
  | {
      ok: false;
      reason:
        | "unreachable"
        | "no-address"
        | "no-far-door"
        | "occupied"
        | "closed"
        | "gone"
        /** The berth holds a dock of this very port with another stamp — a
         *  claim made at the same moment that the CRDT kept, or one made
         *  from the far side: it stands, this one yields (and may join it). */
        | "superseded";
      /** With `superseded`: the stamp of the dock of this port the berth holds. */
      stamp?: number;
      /** With `unreachable`: the far write WAS made, but its acknowledgment
       *  never came — it may still land (redockPort takes it back anyway). */
      unconfirmed?: boolean;
    };

/** ⚓ One dock port as the helm's docking computer and the pane list it. */
export interface DockPortView {
  doorId: string;
  /** The door's display name (its sign, else DOOR n). */
  label: string;
  state: DockPortState;
  /** The module on (or last on) the other side, by name when known. */
  partnerName: string | null;
  /** May the local player dock/undock here (construction rights). */
  canOperate: boolean;
  /** A dock/undock is running on this port right now. */
  busy: boolean;
  /** The last operation's outcome, player-facing. */
  note?: string;
  tone?: "ok" | "warn" | "bad";
}

export class DoorDockingPortSystem {
  private roomsGroup: THREE.Group;
  private doorState: Map<string, DockingState> =
    new Map();
  private doorObjects: Map<string, THREE.Group> = new Map();
  /** Room ENTRY policy (public doors) — distinct from the per-door pairing
   *  lock the terminal manages. Tints every door's status LED so the room's
   *  openness is legible at each threshold. Re-asserted on door (re)build. */
  private accessMode: "public" | "pass" | "keyed" = "pass";
  private adjacentRooms: Map<string, THREE.Mesh> = new Map();
  /** Doors whose UNDOCK button is in the armed (confirm) state, keyed to the
   *  connected room address the arm was FOR — a permanent module removal is
   *  destructive, so it takes two clicks, and the arm must not survive the
   *  pairing changing under the open pane (remove → new module re-dock would
   *  otherwise render pre-armed). Cleared on execute, on pane re-open, and by
   *  render when the live address no longer matches. */
  private undockArmed = new Map<string, string>();

  // ── ⚓ #163: the two-part docking adapter ───────────────────────────────────
  /** The far-room writer main.ts injects (onFarDockWrite). Absent ⇒ DOCK and
   *  UNDOCK stay one-sided, and say so. */
  private farDockWriter:
    | ((req: FarDockRequest) => Promise<FarDockResult>)
    | null = null;
  /** Per-port dock operation, keyed `${roomId}|${doorId}` (see dockOp): in
   *  flight, and the last outcome to show. */
  private dockOps = new Map<
    string,
    { busy: boolean; note?: string; tone?: "ok" | "warn" | "bad" }
  >();
  /** One line under the assembly chips — a refused +DOCK or gangway part. */
  private assemblyNotice: { doorId: string; text: string } | null = null;
  /** Told whenever a port's state or an operation's status changes (the
   *  helm's docking computer re-renders from listDockPorts). */
  private dockListeners = new Set<() => void>();

  // ── Update-loop-driven leaf slides ─────────────────────────────────────────
  /** In-flight slide per door; a new open/close overwrites the entry. */
  private slideAnims = new Map<
    string,
    { openTarget: number; onComplete?: () => void }
  >();
  /** Leaf slide speed (metres/second). */
  private readonly SLIDE_SPEED = 2.2;
  /** 🚪 #159: told whenever the hull's door apertures may have changed
   *  (onDoorApertureChange). */
  private doorApertureListener: (() => void) | null = null;

  // ── Camera-facing door fade (#51) ──────────────────────────────────────────
  /**
   * Per-door deduped material lists for the screen-lower transparency fade.
   * Every door material is created inside buildPorts' per-door loop, so no
   * material is ever shared across doors — a per-door opacity write can't
   * bleed into a neighbour. The fade only touches `.opacity`/`.transparent`;
   * syncLEDStatus tints only `.color` — the two never fight.
   */
  private doorFadeMats: Map<DoorId, THREE.Material[]> = new Map();
  /** Current eased fade opacity per door (1 = solid). */
  private doorFadeOpacity: Map<DoorId, number> = new Map();
  /** Resting opacity of a camera-facing door in the isometric view. */
  private static readonly FACING_FADE_OPACITY = 0.35;
  // Handlers
  private onConnectionRequestCallback:
    | ((doorId: string, address: string) => void)
    | null = null;
  private onPairingStatusChangedCallback:
    | ((doorId: string, status: string) => void)
    | null = null;
  /** #62 P4: main.ts answers "may this address pair without a far-side human?"
   *  — true for modules THIS client minted (the ledger) when AUTO-ACCEPT MY
   *  MODULES is on. Removes 12 hop-accept-hop round trips from the octagon. */
  private autoAcceptCheckCallback: ((address: string) => boolean) | null = null;
  /** Owner gate (vestibule-findings fix): main.ts answers "is the LOCAL player
   *  this room's owner?" — connection changes (request/accept/assembly) are
   *  owner-only, same posture as edit mode. UI-level gating for the dev phase;
   *  read-side enforcement needs signed door records (a later slice). Default
   *  true when unwired so standalone/dev use keeps working. */
  private ownerCheckCallback: (() => boolean) | null = null;

  private isRoomOwner(): boolean {
    return this.ownerCheckCallback ? this.ownerCheckCallback() : true;
  }

  /** #67 D1: may the LOCAL player build (dock/assemble) at this door? Owner
   *  always; otherwise per the door's construction policy — 'public' opens it
   *  to everyone, 'request' honors a standing grant keyed to the player's
   *  identity pub, 'owner' refuses. */
  private canConstruct(doorId: string): boolean {
    if (this.isRoomOwner()) return true;
    const mode = readDoorPolicy(doorId).construction;
    if (mode === "public") return true;
    if (mode === "request") return hasDoorGrant(doorId, getIdentityPub());
    return false;
  }

  /** #67 D1: may the LOCAL player operate (lock/unlock) this door? Follows the
   *  PASSAGE policy — 'public' (default) keeps today's anyone-can behavior. */
  private canOperateDoor(doorId: string): boolean {
    return this.isRoomOwner() || readDoorPolicy(doorId).passage === "public";
  }

  /** Vestibule-findings fix (ghost residue): doors whose chain came from the
   *  armed-preset PREFILL and was never touched by the user. Closing the pane
   *  with the prefill untouched refunds it — merely INSPECTING a keypad must
   *  not leave a ghost tube (or consume parts) as a side effect. Any deliberate
   *  edit or INITIATE clears the flag and the chain becomes intentional. */
  private untouchedPrefills = new Set<string>();
  /**
   * "Buy a module" v0 (T1 of issue #30): mints a fresh room seed against the
   * LOCAL node. Wired by main.ts (callback pattern — docking.ts must not
   * import main.ts). Resolves to the seed link, or null when the node is
   * unreachable.
   */
  private provisionModuleCallback:
    | ((
        templateId: string,
        parentDoorId?: string,
        placement?: {
          wall: DoorWall;
          lateral: number;
          doorId?: string;
          /** ⚓ #163: a dock is staged — the module is born with its door
           *  wearing the other half (fitted at its first claim). */
          port?: boolean;
        },
      ) => Promise<string | null>)
    | null = null;

  /** 🧭 Per-door NEW-MODULE placement choice (the pane's ⟳/◀▶ editor): which
   *  wall of the module-to-be carries its door, and where along it. Drives the
   *  in-world ghost, the mint's birth door, and the pairing's far geometry. */
  private provisionChoice = new Map<string, { wall: DoorWall; lateral: number }>();
  /** The live placement ghost — a wireframe module + green door slab at the
   *  chain's end. One at a time; rebuilt on every choice/chain edit. */
  private provisionGhost: THREE.Group | null = null;
  /** Paints the placement row + ghost — set by setupPanelListeners' closure,
   *  called from handlePanelRaycast when the pane opens. */
  private paintPlacement: ((doorId: string) => void) | null = null;
  /** 🔭 Camera framing saved while the placement ghost holds the room view
   *  WIDE — placing a module is a neighbourhood decision, so the view pulls
   *  back to show the surrounding modules while the ghost lives (owner ask).
   *  Same save/scale/restore idiom as hull-edit (editMode.enter('hull')),
   *  with its own wider factor (see applyPlacementFraming). The CAMERA
   *  REFERENCE is captured alongside the zoom: a first-person dive swaps the
   *  live camera slot, and a restore that re-read the slot would strand the
   *  ortho camera wide (and a later apply would compound the factor). */
  private savedFraming: {
    camera: THREE.OrthographicCamera;
    zoom: number;
  } | null = null;
  /** 🛑📐 The room's OWN translucent shell, shown while the ghost lives so
   *  the hypothesis can be read against the station's true orientation. */
  private provisionRoomShell: THREE.Group | null = null;

  /** 🔭 Exterior-view hook: un-wide the camera BEFORE the space view
   *  snapshots its own zoom baseline (see setPlacementFramingRelease in
   *  exteriorView.ts). The hypothesis itself stays alive. */
  public releasePlacementFraming(): void {
    this.restorePlacementFraming();
  }

  /** 🛑📐 Per-frame sync from world.update: the room-shell aid is an
   *  ISO-ROOM-VIEW visual only (at zoom ≥ 3 the exterior view draws the
   *  room's REAL shell at the same origin — z-fight + plugged window holes;
   *  in first person it sits coplanar with the interior barrel), and the
   *  wide framing RE-ARMS when the room view returns with a live hypothesis
   *  (it was released before the exterior view snapshotted its baseline). */
  public syncPlacementView(zoomLevel: number): void {
    if (this.provisionRoomShell)
      this.provisionRoomShell.visible = zoomLevel === 2;
    if (zoomLevel === 2 && this.provisionGhost && !this.savedFraming)
      this.applyPlacementFraming();
  }

  private applyPlacementFraming(): void {
    if (this.savedFraming !== null) return; // already wide
    // Only from the plain isometric room view (same guard shape as edit mode):
    // FP and the dev views own their own cameras/framing.
    const zoomView = (
      window as unknown as { multiScaleZoom?: { getLevel?: () => number } }
    ).multiScaleZoom;
    if ((zoomView?.getLevel?.() ?? 2) !== 2) return;
    const camera = window.gameRenderer?.camera;
    if (!(camera instanceof THREE.OrthographicCamera)) return;
    this.savedFraming = { camera, zoom: camera.zoom };
    // 0.45, a notch wider than hull-edit's 0.52: the ghost module's far edge
    // sits a full room + tube beyond the wall (~22 m out), and at 0.52 its
    // outer corner still clipped the frame (NDC 1.11, verified numerically).
    camera.zoom *= 0.45;
    camera.updateProjectionMatrix();
  }

  private restorePlacementFraming(): void {
    const saved = this.savedFraming;
    if (!saved) return;
    this.savedFraming = null;
    // The CAPTURED camera, never the live slot — restoring while a different
    // camera is live (level-1 dive mid-placement) is exactly the case that
    // must still un-wide the room view for the return to level 2.
    saved.camera.zoom = saved.zoom;
    saved.camera.updateProjectionMatrix();
  }

  private choiceFor(doorId: string): { wall: DoorWall; lateral: number } {
    let c = this.provisionChoice.get(doorId);
    if (!c) {
      c = { wall: this.defaultBirthWall(doorId), lateral: 0 };
      this.provisionChoice.set(doorId, c);
    }
    return c;
  }

  /** 🧭 Default birth wall MIRRORS the near wall's KIND: docking off the
   *  room's octagon END gets the module's own end (barrels collinear — train
   *  coupling), docking off a flat barrel side gets the module's side. The
   *  old hardcoded 'x-' coupled end-to-side whenever the near door sat on an
   *  octagon face, which read as the new module arriving turned 90° from the
   *  station (owner report, 2026-08-12). ⟳ still cycles all four walls. */
  private defaultBirthWall(doorId: string): DoorWall {
    const near = this.poseForDoor(doorId).wall;
    const { halfX, halfZ } = roomHalfExtents();
    // The near room's octagon ENDS lie on its extrude axis: narrowAxis 'x'
    // ⇒ barrel runs along z ⇒ the ends are the y± walls (and vice versa).
    const nearIsEnd =
      narrowAxisFor(halfX, halfZ) === "x"
        ? near === "y-" || near === "y+"
        : near === "x-" || near === "x+";
    // The module is the standard square shell (narrowAxis ties to 'x'):
    // ITS ends are y±, its flat barrel sides x±.
    return nearIsEnd ? "y-" : "x-";
  }

  /**
   * 🧭 Build (or re-pose) the NEW-MODULE placement ghost for `doorId`: the
   * module-to-be as a wireframe box at the vestibule's end, its birth door as
   * a green slab on the chosen wall at the chosen lateral. Uses the SAME pose
   * math the real projection uses, so what you see is what the station gets.
   * Removed when the pane closes or the door pairs (the real module replaces
   * the hypothesis).
   */
  private updateProvisionGhost(doorId: string): void {
    this.removeProvisionGhost();
    const state = this.doorState.get(doorId);
    if (!state || state.pairedSuccessfully) return;
    const choice = this.choiceFor(doorId);
    const pose = projectionPoseForDoor(
      doorId,
      state.segments,
      choice.wall,
      choice.lateral,
    );
    const g = new THREE.Group();
    g.name = "provision-ghost";
    // Which door this hypothesis belongs to — the remote-accept path uses it
    // to clear a ghost whose door just paired (no pane repaint runs there).
    g.userData.doorId = doorId;
    const H = 5.9; // uniform module half — matches the projection's ROOM_HALF
    // 🧭 The body must be an octagon shell, not a box: the projection rotates
    // the module so the chosen wall always faces the tube, which means on a
    // symmetric box every ⟳ step rendered IDENTICALLY (slab facing the tube,
    // square silhouette) and the rotate button read as dead. The shell's
    // barrel runs along a definite axis, so turning the hypothesis is visible.
    const shell = buildOctagonShell(
      { halfX: H, halfZ: H },
      { opacity: 0.35, edge: 0xd4a84b },
    );
    g.add(shell.group);
    // The birth door: a green slab on the chosen wall, module-local.
    const ns = choice.wall === "y-" || choice.wall === "y+";
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(ns ? 2.0 : 0.24, 2.5, ns ? 0.24 : 2.0),
      new THREE.MeshBasicMaterial({
        color: 0x00e676,
        transparent: true,
        opacity: 0.5,
      }),
    );
    slab.position.set(
      choice.wall === "x+" ? H : choice.wall === "x-" ? -H : choice.lateral,
      1.25,
      choice.wall === "y+" ? H : choice.wall === "y-" ? -H : choice.lateral,
    );
    g.add(slab);
    g.position.set(pose.x, 0, pose.z);
    g.rotation.y = pose.rotY;
    this.roomsGroup.add(g);
    this.provisionGhost = g;
    // 🛑📐 The room's OWN hull, translucent at the room origin: the iso room
    // view renders the interior as an open box (the real barrel is hidden),
    // so without this the station's true orientation is invisible exactly
    // when the ghost must be read against it (owner report: "the old room
    // is misaligned with its actual orientation"). Raycast-inert so door and
    // floor clicks pass straight through it.
    const { halfX, halfZ } = roomHalfExtents();
    const own = buildOctagonShell(
      { halfX, halfZ },
      { opacity: 0.2, edge: 0xd4a84b },
    );
    own.group.traverse((o) => {
      o.raycast = () => {};
    });
    this.roomsGroup.add(own.group);
    this.provisionRoomShell = own.group;
    // 🔭 Pull the room view back while the hypothesis lives. Rebuilds pass
    // through removeProvisionGhost first (restore → re-apply, same values),
    // both synchronous — no frame renders between, so nothing flickers.
    this.applyPlacementFraming();
  }

  private removeProvisionGhost(): void {
    this.restorePlacementFraming();
    const shell = this.provisionRoomShell;
    if (shell) {
      this.provisionRoomShell = null;
      this.roomsGroup.remove(shell);
      shell.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = (m as { material?: THREE.Material }).material;
        if (mat) mat.dispose();
      });
    }
    const g = this.provisionGhost;
    if (!g) return;
    this.provisionGhost = null;
    this.roomsGroup.remove(g);
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as { material?: THREE.Material }).material;
      if (mat) mat.dispose();
    });
  }

  constructor(roomsGroup: THREE.Group) {
    this.roomsGroup = roomsGroup;
    this.initializeDoorStates();
    // 🛰️ hull.ts occupancy: exterior-mount validation consults our built
    // chains (latest instance wins — exactly one system is live per room).
    setChainBoxProvider(() => this.builtChainBoxes());
  }

  /**
   * 🛰️ XZ boxes swept by every door's CURRENT chain, folded joint by joint
   * (chain-local frame → world via the door's face + yaw — the same
   * transform family as projectionPoseForDoor). Padded to the vestibule's
   * half-width so a mount can't sit flush against a tube wall either.
   */
  private builtChainBoxes(): Box[] {
    const out: Box[] = [];
    // 🛰️ EVERY door with a chain, not just cardinals: a free door can grow a
    // gangway now, and a tube that reserves no exterior space lets a solar
    // panel be mounted straight through it.
    for (const doorId of this.doorState.keys()) {
      out.push(...this.chainBoxesFor(doorId));
    }
    return out;
  }

  /** One door's chain, folded joint by joint into padded world-XZ boxes.
   *  ⚓ #163: a door wearing a dock port with nothing staged still owns the
   *  space its sealed half sticks out into — a mount may not go through it. */
  private chainBoxesFor(doorId: string): Box[] {
    const staged = this.doorState.get(doorId)?.segments ?? [];
    const segs: ConnectorSegment[] =
      staged.length === 0 && readDoorPolicy(doorId).adapter
        ? [{ kind: "dock" }]
        : staged;
    if (segs.length === 0) return [];
    // A gangway part's half-width; a dock half pads by the adapter's own
    // widest radius (hull flange, ~1.94 m), not the gangway's.
    const PAD = 0.85;
    const padFor = (seg: ConnectorSegment) =>
      seg.kind === "dock" ? Math.max(PAD, DOCK_ENVELOPE_R) : PAD;
    // 🚪 #91: anchor on the door's LIVE pose (slide delta included). Without
    // the delta these occupancy/clash boxes sat at the unslid position while
    // buildConnectorChain drew the tube at the slid one — the warnings and the
    // thing on screen disagreed.
    const pose = this.poseForDoor(doorId);
    const face = { x: pose.x, z: pose.z };
    const yaw = pose.outwardYaw;
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    const toWorld = (lx: number, lz: number) => ({
      x: face.x + lx * c + lz * s,
      z: face.z - lx * s + lz * c,
    });
    const out: Box[] = [];
    let prev = toWorld(0, 0);
    for (let i = 1; i <= segs.length; i++) {
      const p = foldChainEnd(segs.slice(0, i));
      const cur = toWorld(p.x, p.z);
      const pad = padFor(segs[i - 1]);
      out.push({
        x0: Math.min(prev.x, cur.x) - pad,
        z0: Math.min(prev.z, cur.z) - pad,
        x1: Math.max(prev.x, cur.x) + pad,
        z1: Math.max(prev.z, cur.z) + pad,
      });
      prev = cur;
    }
    return out;
  }

  private initializeDoorStates() {
    const directions: ("north" | "south" | "east" | "west")[] = [
      "north",
      "south",
      "east",
      "west",
    ];
    for (const dir of directions) this.ensureDoorState(dir);
  }

  /** The one canonical default `DockingState`. Every site that may need to
   *  create a door's state (cardinal seeding, layout rebuild, a remote pairing
   *  arriving before the group exists) goes through here, so the default shape
   *  cannot drift between them. An existing state is returned untouched. */
  private ensureDoorState(doorId: string): DockingState {
    let state = this.doorState.get(doorId);
    if (!state) {
      state = {
        doorId,
        locked: false,
        pinCode: "",
        connectedRoomAddress: "",
        pairingPending: false,
        pairedSuccessfully: false,
      };
      this.doorState.set(doorId, state);
    }
    return state;
  }

  /**
   * Build 3D geometries and click target boxes for our 4 Doors.
   * conformed precisely to the grid: small doors take 1 grid cell width (1.0m on wall)
   * large doors take 2 grid cells width (2.0m on wall)
   */
  /**
   * 🚪↔🛰️ #28 S5a: the world pose of a door by id. A CARDINAL door routes
   * through physicalDoorPose (legacy east/west quirk + pairs layout preserved
   * EXACTLY); a free/genId door derives from poseFromWall using the wall +
   * lateral stashed on its group's userData.
   */
  private poseForDoor(id: string): PhysicalDoorPose {
    if (id === "north" || id === "south" || id === "east" || id === "west") {
      return physicalDoorPose(id);
    }
    const ud = this.doorObjects.get(id)?.userData as
      | { wall?: DoorWall; lateral?: number }
      | undefined;
    return poseFromWall(ud?.wall ?? "y-", ud?.lateral ?? 0);
  }

  public buildPorts() {
    console.log("🚪 Constructing 4-Directional Docking Ports & Control Panels");

    // 🚪 #91: one door size — the config is just the 4 cardinal berths now.
    for (const id of ["north", "south", "west", "east"] as const) {
      // At build time (World construction) the doorLayout doc is not bound yet,
      // so the default 4 come from this local config; the slice-5b reconcile
      // adds/removes groups from the synced map afterward.
      this.buildDoorGroup({
        id,
        wall: LEGACY_ID_WALL[id],
        lateral: 0,
        size: "large",
        enabled: findDoor(id)?.enabled === true,
      });
    }

    this.mountInterfaceControlPanel();
  }

  /**
   * 🚪↔🛰️ #28 S5a: build ONE door group from a layout record — extracted from
   * buildPorts so the reconcile can add/remove doors (slice 5b). Bit-identical
   * for the 4 cardinals: `cfg` reconstructs the old loop variable so the body is
   * unchanged, and the pose routes through poseForDoor (cardinal →
   * physicalDoorPose exactly, preserving the legacy east/west quirk + pairs).
   */
  private buildDoorGroup(record: DoorLayoutRecord): void {
    const cfg = { id: record.id as DoorId, isLarge: record.size === "large" };
    // 🚪 #91: derive the pose from the RECORD, not from poseForDoor(id) — a
    // brand-new free door is not in doorObjects yet, so poseForDoor's userData
    // lookup missed and every one was born mid-north-wall (it self-healed only
    // because reconcileDoorPlacements re-posed it microseconds later).
    // Cardinals still route through poseForDoor so the layout tables own them.
    const pose = isCardinalDoorId(record.id)
      ? this.poseForDoor(record.id)
      : poseFromWall(record.wall, record.lateral);
    // A new door needs its own pairing state so its LED / keypad / slide work
    // (the 4 cardinals are already seeded by initializeDoorStates → no-op).
    this.ensureDoorState(cfg.id);
      const doorGroup = new THREE.Group();
      doorGroup.position.set(pose.x, 2, pose.z);
      doorGroup.rotation.y = pose.frameYaw;

      // 🚪↔🛰️ #28 S4b: split each group into the structural PORT HARDWARE (keypad
      // + status LED — one per berth) and the DOOR LEAVES (frame, sliding panels,
      // threshold, click box). Both sit at the group origin, so every child's
      // world transform — and thus render / slide / fade / raycast — is identical
      // to before. The split just lets slice 5 move a free door's leaves while its
      // port hardware stays at the berth. Every group accessor (getObjectByName,
      // traverse) is recursive, so nothing else changes; only startSlide reads
      // userData non-recursively, so isLarge stays on the TOP group below.
      const doorLeaves = new THREE.Group();
      doorLeaves.name = "doorLeaves";
      const portHardware = new THREE.Group();
      portHardware.name = "portHardware";

      // Walkability comes from the door registry: the north port hides behind
      // the fireplace, so it gets NO click box and NO isDoorBody tags —
      // otherwise fireplace clicks would trigger it.
      const walkable = findDoor(cfg.id)?.enabled === true;
      const bodyData = {
        isDoorBody: true,
        doorId: cfg.id,
        doorBodyCandidate: true,
      };

      // Local geometry conventions: group centre sits at world y=2, so the
      // floor is local y=-2. 🚪 #91: ONE door size, REDRAWN onto the grid —
      // the opening is exactly 2 grid cells (2.0 m) so a door centred on a
      // grid line sits flush between two squares. Everything below derives
      // from the shared constants in doorLayout.ts, which the editor's
      // validators read too — geometry and collision model cannot drift apart
      // again (they did: the old 2.4/1.4 openings matched no whole number of
      // cells while the validators assumed 2/1).
      const openingWidth = DOOR_OPENING_WIDTH;
      const OPEN_H = DOOR_OPENING_HEIGHT; // opening height (local y -2 .. 1)
      const POST_W = DOOR_POST_WIDTH; // side post width
      const FRAME_D = 0.5; // frame depth
      const FLOOR_Y = -2; // local floor level

      // ── 1. Frame: two grounded side posts + header (gunmetal) ──────────────
      const frameMat = new THREE.MeshStandardMaterial({
        color: 0x2a3444,
        roughness: 0.6,
        metalness: 0.35,
      });
      const postGeo = new THREE.BoxGeometry(POST_W, OPEN_H, FRAME_D);
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, frameMat);
        post.position.set(
          side * (openingWidth / 2 + POST_W / 2),
          FLOOR_Y + OPEN_H / 2,
          0,
        );
        post.userData = walkable
          ? { ...bodyData }
          : { doorId: cfg.id, doorBodyCandidate: true };
        doorLeaves.add(post);
      }
      const header = new THREE.Mesh(
        new THREE.BoxGeometry(openingWidth + POST_W * 2, 0.5, FRAME_D),
        frameMat,
      );
      header.position.set(0, FLOOR_Y + OPEN_H + 0.25, 0);
      header.userData = walkable
        ? { ...bodyData }
        : { doorId: cfg.id, doorBodyCandidate: true };
      doorLeaves.add(header);

      // ── 2. Emissive frame strips (status-tinted via syncLEDStatus) ─────────
      const glowMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
      for (const side of [-1, 1]) {
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(0.06, OPEN_H, 0.06),
          glowMat,
        );
        strip.position.set(
          side * (openingWidth / 2 + 0.03),
          FLOOR_Y + OPEN_H / 2,
          FRAME_D / 2,
        );
        strip.name = "frameGlow";
        doorLeaves.add(strip);
      }
      const headerStrip = new THREE.Mesh(
        new THREE.BoxGeometry(openingWidth, 0.06, 0.06),
        glowMat,
      );
      headerStrip.position.set(0, FLOOR_Y + OPEN_H + 0.03, FRAME_D / 2);
      headerStrip.name = "frameGlow";
      doorLeaves.add(headerStrip);

      // ── 3. Leaves as groups (slide code only touches .position.x) ──────────
      const leafWidth = openingWidth / 2;
      const steelMat = new THREE.MeshStandardMaterial({
        color: 0x37474f,
        roughness: 0.5,
        metalness: 0.55,
      });
      const grooveMat = new THREE.MeshStandardMaterial({
        color: 0x1c262e,
        roughness: 0.85,
        metalness: 0.2,
      });
      const slitMat = new THREE.MeshBasicMaterial({ color: 0x9be7ff });
      const chevronMat = new THREE.MeshStandardMaterial({
        color: 0xd4a84b,
        roughness: 0.4,
        metalness: 0.5,
      });
      const kickMat = new THREE.MeshStandardMaterial({
        color: 0x10161d,
        roughness: 0.9,
        metalness: 0.1,
      });

      const buildLeaf = (
        name: "leftLeaf" | "rightLeaf",
        closedOffset: number,
      ): THREE.Group => {
        const leaf = new THREE.Group();
        leaf.name = name;
        // Grounded: panel spans local y -2 .. 1
        leaf.position.set(closedOffset, FLOOR_Y + OPEN_H / 2, 0.05);
        const inner = name === "leftLeaf" ? 1 : -1; // toward the centre seam

        // Base steel panel
        const panel = new THREE.Mesh(
          new THREE.BoxGeometry(leafWidth, OPEN_H, 0.15),
          steelMat,
        );
        leaf.add(panel);

        // Recessed groove strips
        for (const gy of [1.05, 0.55, -0.65]) {
          const groove = new THREE.Mesh(
            new THREE.BoxGeometry(leafWidth - 0.12, 0.05, 0.02),
            grooveMat,
          );
          groove.position.set(0, gy, 0.075);
          leaf.add(groove);
        }

        // Vertical emissive window slit at the INNER edge — the closed door
        // reads as a lit centre seam.
        const slit = new THREE.Mesh(
          new THREE.BoxGeometry(0.08, 1.2, 0.03),
          slitMat,
        );
        slit.position.set(inner * (leafWidth / 2 - 0.07), 0, 0.08);
        leaf.add(slit);

        // Amber chevron plate, angled toward the seam
        const chevron = new THREE.Mesh(
          new THREE.BoxGeometry(leafWidth * 0.55, 0.16, 0.02),
          chevronMat,
        );
        chevron.position.set(0, -1.0, 0.08);
        chevron.rotation.z = inner * 0.5;
        leaf.add(chevron);

        // Dark kick plate near the bottom
        const kick = new THREE.Mesh(
          new THREE.BoxGeometry(leafWidth, 0.35, 0.03),
          kickMat,
        );
        kick.position.set(0, -OPEN_H / 2 + 0.2, 0.08);
        leaf.add(kick);

        leaf.children.forEach((child) => {
          child.userData = walkable
            ? { ...bodyData }
            : { doorId: cfg.id, doorBodyCandidate: true };
        });
        return leaf;
      };

      doorLeaves.add(buildLeaf("leftLeaf", -DOOR_LEAF_SHUT_OFFSET));
      doorLeaves.add(buildLeaf("rightLeaf", DOOR_LEAF_SHUT_OFFSET));

      // ── 4. Floor threshold plate + emissive guide strips ───────────────────
      const threshold = new THREE.Mesh(
        new THREE.BoxGeometry(openingWidth + 0.6, 0.04, 0.9),
        new THREE.MeshStandardMaterial({
          color: 0x232e3a,
          roughness: 0.7,
          metalness: 0.3,
        }),
      );
      threshold.position.set(0, -1.98, 0);
      doorLeaves.add(threshold);
      for (const gz of [-0.35, 0.35]) {
        const guide = new THREE.Mesh(
          new THREE.BoxGeometry(openingWidth + 0.5, 0.015, 0.05),
          glowMat,
        );
        guide.position.set(0, -1.95, gz);
        guide.name = "frameGlow";
        doorLeaves.add(guide);
      }

      // ── 5. Invisible click box covering the doorway ───────────────────────
      // Always built: a room theme may move a blocked logical door to a clear
      // slot and enable it without rebuilding the whole platform.
      const clickBox = new THREE.Mesh(
        new THREE.BoxGeometry(openingWidth + 0.6, 3.4, 0.5),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      clickBox.position.set(0, -0.3, 0);
      clickBox.userData = walkable
        ? { ...bodyData }
        : { doorId: cfg.id, doorBodyCandidate: true };
      doorLeaves.add(clickBox);

      // We attach the isLarge metadata onto the group so our slider knows the correct target panning offsets
      doorGroup.userData = { isLarge: cfg.isLarge };

      // 3+4. PORT HARDWARE — keypad + status LED. Every door (including free
      // `d:` doors) gets a panel mounted on the FRONT FACE of the door post so
      // the control is an integral part of the door and requires no separate
      // wall mount. Cardinal doors open the full docking pane; free doors open
      // a simplified settings panel (lock state + PIN + passage policy).
      {
        const keypadGeo = new THREE.BoxGeometry(0.3, 0.4, 0.12);
        const keypadMat = new THREE.MeshStandardMaterial({
          color: 0xd4a84b,
          metalness: 0.5,
        });
        const keypad = new THREE.Mesh(keypadGeo, keypadMat);
        // Centre on the right post, flush with the room-interior-facing surface.
        // Local +z points into the room for every door orientation (frameYaw
        // rotates so that the room side is always +z), so FRAME_D/2 is the
        // front face. The keypad (depth 0.12) is centred at FRAME_D/2 + 0.07
        // so its back face sits just proud of the post surface.
        const onFaceX = DOOR_OPENING_WIDTH / 2 + DOOR_POST_WIDTH / 2;
        keypad.position.set(onFaceX, -0.2, FRAME_D / 2 + 0.07);
        keypad.name = `keypad_${cfg.id}`;
        // Store reference inside trigger metadata
        keypad.userData = { isControlPanel: true, doorId: cfg.id };
        portHardware.add(keypad);

        const ledGeo = new THREE.SphereGeometry(0.06, 16, 16);
        const ledMat = new THREE.MeshBasicMaterial({ color: 0xff1744 }); // Default locked/red indicator
        const led = new THREE.Mesh(ledGeo, ledMat);
        led.position.set(onFaceX, 0.1, FRAME_D / 2 + 0.08);
        led.name = "ledStatus";
        portHardware.add(led);
      }

      // Attach both halves; the top group is still what doorObjects tracks and
      // what repositionDoorGroups / the fade traverse operate on.
      doorGroup.add(doorLeaves);
      doorGroup.add(portHardware);

      this.roomsGroup.add(doorGroup);
      this.doorObjects.set(cfg.id, doorGroup);

      // #51: collect this door's materials for the camera-facing fade.
      // Dedupe (one material serves several meshes within the door) and skip
      // the invisible click box (its material must stay untouched).
      const fadeMats: THREE.Material[] = [];
      const seenMats = new Set<THREE.Material>();
      doorGroup.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        for (const mat of mats) {
          if (!mat || mat.visible === false || seenMats.has(mat)) continue;
          seenMats.add(mat);
          fadeMats.push(mat);
        }
      });
      this.doorFadeMats.set(cfg.id, fadeMats);
      this.doorFadeOpacity.set(cfg.id, 1);

      // Paint LED + frame glow from the door's initial state — and if the
      // RETAINED state says paired (apply-then-rebuild: the remote pairing
      // landed before this rebuild replaced the group), slide the fresh
      // leaves open too. Cold load and rebuild-then-apply both end in
      // applyRemotePairing's openDoor, so this makes the third ordering
      // converge to the same visual instead of a shut-but-green door.
      const state = this.doorState.get(cfg.id);
      if (state) {
        this.syncLEDStatus(cfg.id, state);
        if (state.pairedSuccessfully && !state.locked) this.openDoor(cfg.id);
      }

      // #28 S5a: stash the pose basis so poseForDoor can reposition a free /
      // genId door (reconcile + fade) without a cardinal lookup — onto {isLarge}.
      doorGroup.userData.wall = record.wall;
      doorGroup.userData.lateral = record.lateral;
  }

  /**
   * 🚪 #28 S6b (door editor): the live door GROUPS by id — the edit-mode raycast
   * index traverses each group's meshes so a door can be hovered / selected /
   * removed like furniture. The invisible click box (material.visible:false)
   * still raycasts, so every door is a fat, reliable target.
   */
  public getDoorGroups(): Map<string, THREE.Group> {
    return this.doorObjects;
  }

  /**
   * 🚪 #28 S6b: is this door part of a live pairing? The editor refuses to
   * REMOVE a paired door ("unpair first") so #62 chain math never re-solves
   * around a door that vanished mid-connection (same guard the slide code uses).
   */
  public isDoorPaired(id: string): boolean {
    return this.doorState.get(id)?.pairedSuccessfully === true;
  }

  /**
   * 🚪↔🛰️ #28 S5b: remove a door group (reconcile deletion / editor remove).
   * Disposes its geometry + materials (materials are per-door, so dedupe-and-
   * dispose is safe) and clears every per-door map entry so nothing leaks.
   */
  public removeDoorGroup(id: string): void {
    const group = this.doorObjects.get(id);
    if (!group) return;
    this.roomsGroup.remove(group);
    const seen = new Set<THREE.Material>();
    group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (mat && !seen.has(mat)) {
          seen.add(mat);
          mat.dispose();
        }
      }
    });
    this.doorObjects.delete(id);
    this.doorFadeMats.delete(id as DoorId);
    this.doorFadeOpacity.delete(id as DoorId);
    this.doorState.delete(id as DoorId);
    this.slideAnims.delete(id);
    this.removeAdjacentRoomProjection(id as DoorId); // tear down any projection
    this.untouchedPrefills.delete(id);
    this.doorApertureListener?.(); // 🚪 #159: an open door just left the wall
  }

  /**
   * 🚪↔🛰️ #28 S5b: reconcile the 3D door GROUPS to a layout snapshot — add a
   * group for a new record, remove one whose id left the map, rebuild one whose
   * SIZE changed (leaf width differs), and refresh the stashed pose basis for a
   * moved door. Position is applied afterward by reconcileDoorPlacements. For the
   * 4 seeded cardinals every group already exists at the same size → a no-op.
   */
  public syncDoorGroups(records: Map<string, DoorLayoutRecord>): void {
    // Removals first — ids present in the scene but gone from the map.
    for (const id of [...this.doorObjects.keys()]) {
      if (!records.has(id)) this.removeDoorGroup(id);
    }
    // Adds + size-change rebuilds + moved-door basis refresh.
    for (const record of records.values()) {
      const group = this.doorObjects.get(record.id);
      if (!group) {
        this.buildDoorGroup(record);
        continue;
      }
      if (group.userData.isLarge !== (record.size === "large")) {
        this.removeDoorGroup(record.id);
        this.buildDoorGroup(record);
      } else {
        group.userData.wall = record.wall;
        group.userData.lateral = record.lateral;
      }
    }
  }

  /**
   * Mount floating interactive terminal to manage Room addresses, Pin-codes and pairings
   */
  private mountInterfaceControlPanel() {
    const pane = document.createElement("div");
    pane.id = "docking-control-pane";
    pane.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 380px;
      max-height: 80vh;
      background: rgba(4, 8, 22, 0.95);
      border: 1px solid rgba(212, 168, 75, 0.28);
      border-radius: 12px;
      box-shadow: 0 12px 64px rgba(0,0,0,0.9);
      padding: 24px;
      display: none;
      flex-direction: column;
      gap: 16px;
      overflow: hidden;
      color: #d4a84b;
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      z-index: 6000;
      box-sizing: border-box;
    `;

    pane.innerHTML = `
      <div style="flex:0 0 auto; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:10px;">
        <span id="docking-pane-title" style="font-size:12px; font-weight:800; color:#F0C060; letter-spacing:1px;">🚪 DOCKING PORT CONTROL</span>
        <!-- type=button: this pane is built inside no form today, but the HTML
             default is submit, and a bare <button> that ever ends up in one
             reloads the page. aria-label/title because the glyph is the entire
             label: a screen reader would otherwise announce "X", and this is
             the ONLY way to dismiss the pane (no Esc handler), which is exactly
             why the header is pinned above the scroll region. -->
        <button id="docking-close-btn" type="button" aria-label="Close door control panel" title="Close" style="background:rgba(212,168,75,0.1); border:1px solid rgba(212,168,75,0.3); border-radius:6px; color:#d4a84b; font-size:10px; padding:4px 8px; cursor:pointer;">X</button>
      </div>

      <!-- 📜 Scroll region. The pane caps at 80vh and this is the part that
           scrolls, so the header — and with it the X, the ONLY way to close the
           pane (there is no Esc handler) — stays pinned. min-height:0 is what
           actually lets a flex child shrink below its content and scroll;
           without it the child keeps its full intrinsic height and the pane
           overflows its own max-height instead. margin/padding-right give the
           scrollbar its own gutter so it never sits on top of the controls. -->
      <div id="docking-pane-scroll" style="flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; display:flex; flex-direction:column; gap:16px; margin-right:-10px; padding-right:10px;">

      <div style="display:flex; flex-direction:column; gap:12px; font-size:11px;">
        <!-- 🪧 DOOR SIGN — the owner's ruling: instead of the app deciding what
             a door leads to from its cardinal ID (the pool sign was welded to
             the door called "south", the casino sign to "east"), the room
             author types it. Works on EVERY door, cardinal or free d: —
             deliberately outside the isCardinal show/hide block below, because
             a user-placed door is exactly the one nobody can otherwise label.
             maxlength mirrors DOOR_LABEL_MAX; sanitizeDoorLabel is still the
             authority at the write boundary (paste bypasses maxlength). -->
        <div id="docking-label-row">
          <label for="docking-label-input" style="display:block; margin-bottom:4px; color:rgba(212,168,75,0.6);">🪧 DOOR SIGN <span id="docking-label-note" style="color:rgba(212,168,75,0.38); font-size:9px;">· what is on the other side</span></label>
          <input type="text" id="docking-label-input" maxlength="${DOOR_LABEL_MAX}" placeholder="e.g. POOL, CASINO, DOCK 3 — blank for none" style="width:100%; border-radius:6px; border:1px solid rgba(212,168,75,0.18); background:rgba(0,0,0,0.3); color:#d4a84b; padding:6px 10px; font-size:11px; outline:none; font-family:monospace; box-sizing:border-box;">
        </div>

        <!-- ⚓ #163 DOCK row: a door wearing a docking-adapter port says what
             is on the other side of it and offers DOCK / UNDOCK right here,
             at the top — not inside the collapsed policy section, where the
             old transient DETACH was hard to find. Rendered by renderDockRow. -->
        <div id="docking-dock-row" style="display:none;"></div>

        <!-- Lock config -->
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span>LOCK STATE CONFIG:</span>
          <button id="docking-lock-toggle" style="background:#ff1744; border:none; border-radius:4px; color:#fff; font-weight:bold; padding:4px 10px; cursor:pointer;">LOCKED</button>
        </div>

        <div>
          <label style="display:block; margin-bottom:4px; color:rgba(212,168,75,0.6);">SECURITY PIN CODE:</label>
          <input type="text" id="docking-pin-input" placeholder="e.g. 1106" style="width:100%; border-radius:6px; border:1px solid rgba(212,168,75,0.18); background:rgba(0,0,0,0.3); color:#d4a84b; padding:6px 10px; font-size:11px; outline:none; font-family:monospace;">
        </div>

        <!-- #62 P4: CONNECTION ASSEMBLY — chain chips + far-side controls.
             Parts come from the DEV PARTS inventory; the armed preset prefills
             on pane open. The chain renders in-world as a ghost while unpaired
             and publishes with the pairing record (P2/P3 machinery). -->
        <div id="docking-assembly" style="border-top:1px solid rgba(212,168,75,0.14); padding-top:10px;">
          <label style="display:block; margin-bottom:4px; color:rgba(212,168,75,0.6);">CONNECTION ASSEMBLY <span id="docking-parts-note" style="color:rgba(212,168,75,0.38); font-size:9px;"></span></label>
          <div id="docking-chips" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px; min-height:20px;"></div>
          <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
            <button id="docking-add-flex" style="background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:#d4a84b; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">+FLEX</button>
            <button id="docking-add-ext" style="background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:#d4a84b; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">+EXT</button>
            <!-- ⚓ #163: the docking-adapter vestibule. First press fits THIS
                 door's half (a round port); second press stages the MATING
                 half the connection brings to the far door. -->
            <button id="docking-add-dock" type="button" title="Docking adapter — first press fits this door's round port, second adds the other half for the module on the far side" style="background:rgba(242,239,230,0.10); border:1px solid rgba(242,239,230,0.45); border-radius:5px; color:#f2efe6; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">+DOCK</button>
            <button id="docking-clear-chain" style="background:rgba(255,23,68,0.08); border:1px solid rgba(255,23,68,0.3); border-radius:5px; color:#ff8a80; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">CLEAR</button>
            <span style="flex:1;"></span>
            <span style="font-size:9px; color:rgba(212,168,75,0.55);">FAR:</span>
            <!-- 🧭 Populated per-TARGET with the far module's REAL doors
                 (renderFarDoorOptions) — the four hardcoded compass options
                 were guesses about a stranger's room, meaningless once doors
                 move and modules rotate. "auto" always works: the first
                 walk-through's mirror names the door precisely. -->
            <select id="docking-far-door" style="background:rgba(0,0,0,0.3); border:1px solid rgba(212,168,75,0.25); border-radius:5px; color:#d4a84b; font-size:9px; padding:2px 4px;">
              <option value="">auto</option>
            </select>
            <button id="docking-far-yaw" style="background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:#d4a84b; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">YAW —</button>
          </div>
          <!-- 🧲 Chain-contact detection (owner's ask): when the working chain's
               far end lands on a KNOWN module (station atlas), offer the
               connection right here. Rendered by detectChainContact. -->
          <div id="docking-dock-detect" style="display:none; margin-top:6px;"></div>
        </div>

        <!-- Connection address -->
        <div>
          <label style="display:block; margin-bottom:4px; color:rgba(212,168,75,0.6);">TARGET CONNECTED ROOM ADDRESS:</label>
          <input type="text" id="docking-addr-input" placeholder="Paste target seed link..." style="width:100%; border-radius:6px; border:1px solid rgba(212,168,75,0.18); background:rgba(0,0,0,0.3); color:#d4a84b; padding:6px 10px; font-size:11px; outline:none; font-family:monospace;">
          <!-- 🗺️ Known-modules picker (owner's 8th→1st finding): every module
               the station atlas has an address for, one tap to target — the
               close-the-ring flow without the zoom-out dance. -->
          <select id="docking-known-modules" style="width:100%; margin-top:5px; border-radius:6px; border:1px solid rgba(212,168,75,0.18); background:rgba(0,0,0,0.3); color:#d4a84b; padding:5px 8px; font-size:10px; outline:none;">
            <option value="">🗺️ … or pick a KNOWN MODULE</option>
          </select>
        </div>

        <!-- "Buy a module" v0 (T1 of #30): mint a fresh room on the local node
             and drop its seed into the address input, ready to pair. The new
             room is born from the chosen template (🏗️ room-templates). -->
        <select id="docking-provision-template" title="What the new room starts as" style="width:100%; margin-bottom:5px; border-radius:6px; border:1px solid rgba(212,168,75,0.18); background:rgba(0,0,0,0.3); color:#d4a84b; padding:5px 8px; font-size:10px; outline:none;">
          ${ROOM_TEMPLATES.map((t) => `<option value="${t.id}">🏗️ NEW ROOM: ${t.name.toUpperCase()}</option>`).join("")}
        </select>
        <!-- 🧭 NEW-MODULE DOOR PLACEMENT (owner ask): before committing the
             module, ROTATE which of its walls carries the birth door and SHIFT
             the door along that wall — a live wireframe ghost at the chain's
             end shows exactly what the station gets. -->
        <div id="docking-provision-place" style="display:flex; align-items:center; gap:6px; margin-bottom:5px; font-size:10px;">
          <span style="color:rgba(212,168,75,0.6);">NEW MODULE DOOR:</span>
          <button id="docking-place-rotate" type="button" title="Rotate the new module — which of its walls carries the door" style="background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:#d4a84b; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">⟳ WEST</button>
          <span style="flex:1;"></span>
          <button id="docking-place-left" type="button" title="Shift the door along its wall" style="background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:#d4a84b; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">◀</button>
          <span id="docking-place-lat" style="min-width:44px; text-align:center; color:rgba(212,168,75,0.7); font-size:9px;">CENTRE</span>
          <button id="docking-place-right" type="button" title="Shift the door along its wall" style="background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:#d4a84b; font-size:9px; font-weight:700; padding:3px 8px; cursor:pointer;">▶</button>
        </div>
        <button id="docking-provision-btn" style="width:100%; border-radius:6px; border:1px solid #d4a84b; background:rgba(212,168,75,0.12); color:#f0c060; padding:8px; font-weight:bold; cursor:pointer; text-transform:uppercase;">➕ PROVISION NEW MODULE</button>

        <button id="docking-request-btn" style="width:100%; border-radius:6px; border:1px solid #1e88e5; background:rgba(30,136,229,0.15); color:#90caf9; padding:8px; font-weight:bold; cursor:pointer; text-transform:uppercase;">INITIATE PORT PLUG PAIRING</button>

        <!-- #67 D1/D1b: per-door policy + rights requests — COLLAPSED by
             default (regression fix: this block above the assembly pushed the
             chain pills below the fold; assembly is the primary action, this
             is configuration). Rendered by renderPolicySection. -->
        <details id="docking-policy" style="border-top:1px solid rgba(212,168,75,0.14); padding-top:8px;">
          <summary style="cursor:pointer; color:rgba(212,168,75,0.6); font-size:10px; letter-spacing:1px; user-select:none;">⚙ DOOR POLICY · RIGHTS · POSITION</summary>
          <div id="docking-policy-body" style="display:flex; flex-direction:column; gap:6px; font-size:10px; margin-top:8px;"></div>
        </details>
      </div>

      <!-- Pairing notifications -->
      <div id="docking-pairing-box" style="display:none; flex-direction:column; gap:8px; border-top:1px solid rgba(212,168,75,0.18); padding-top:10px; margin-top:5px;">
        <span style="font-size:10px; color:#ffb300; font-weight:800; animation: blink 1.5s infinite;">⚠️ INBOUND CONNECTION REQUEST DETECTED</span>
        <span style="font-size:9.5px; color:rgba(212,168,75,0.7); line-height:1.3;">A remote clone capsule wishes to dock with your terminal. Accept pairing?</span>
        <div style="display:flex; gap:8px;">
          <button id="docking-accept-btn" style="flex:1; background:#00e676; border:none; border-radius:4px; color:#01020a; font-weight:bold; padding:6px; cursor:pointer; font-size:10px;">ACCEPT</button>
          <button id="docking-reject-btn" style="flex:1; background:#ff1744; border:none; border-radius:4px; color:#fff; font-weight:bold; padding:6px; cursor:pointer; font-size:10px;">REJECT</button>
        </div>
      </div>

      </div><!-- /#docking-pane-scroll -->
    `;

    document.body.appendChild(pane);
    this.setupPanelListeners();
  }

  private setupPanelListeners() {
    const closeBtn = document.getElementById("docking-close-btn");
    const lockBtn = document.getElementById("docking-lock-toggle");
    const requestBtn = document.getElementById("docking-request-btn");
    const acceptBtn = document.getElementById("docking-accept-btn");
    const rejectBtn = document.getElementById("docking-reject-btn");
    const box = document.getElementById("docking-control-pane");

    if (closeBtn) closeBtn.addEventListener("click", () => this.dismissPanel());

    // Handle clicks inside the modal to prevent passing them to 3D world floor clicks
    box?.addEventListener("click", (e) => e.stopPropagation());

    // Toggle Port Lock State
    if (lockBtn) {
      lockBtn.addEventListener("click", () => {
        const pane = document.getElementById("docking-control-pane");
        const activeDoorId = pane ? (pane as any).activeDoorId : null;
        if (!activeDoorId) return;
        // #67 D1: lock/unlock follows the PASSAGE policy (this control was
        // accidentally ungated before the policy work surfaced it).
        if (!this.canOperateDoor(activeDoorId)) {
          alert("This door's passage is owner-restricted.");
          return;
        }
        const state = this.doorState.get(activeDoorId);
        if (state) {
          state.locked = !state.locked;
          lockBtn.textContent = state.locked ? "LOCKED" : "UNLOCKED";
          lockBtn.style.background = state.locked ? "#ff1744" : "#00e676";
          lockBtn.style.color = state.locked ? "#fff" : "#01020a";
          this.syncLEDStatus(activeDoorId, state);
          if (state.locked) this.closeDoor(activeDoorId);
          else this.openDoor(activeDoorId);
        }
      });
    }

    // Provision a fresh module room on the local node (T1 of #30) and fill
    // the address input with its seed — the user then pairs to it normally.
    const provisionBtn = document.getElementById(
      "docking-provision-btn",
    ) as HTMLButtonElement | null;
    if (provisionBtn) {
      provisionBtn.addEventListener("click", async () => {
        if (!this.provisionModuleCallback) {
          alert("Module provisioning is not available (no local node wiring).");
          return;
        }
        const originalLabel = provisionBtn.textContent;
        const templateSelect = document.getElementById(
          "docking-provision-template",
        ) as HTMLSelectElement | null;
        const templateId = templateSelect?.value || "empty";
        provisionBtn.disabled = true;
        provisionBtn.textContent = "MINTING MODULE…";
        try {
          // 🛰️🚪 Hand the minting side the BERTH this module is being added
          // from. That is what lets the new room be born with exactly one
          // door — the one leading back here — instead of inheriting a full
          // set of cardinals. Same source the INITIATE handler below reads.
          const pane = document.getElementById("docking-control-pane");
          const parentDoorId = pane
            ? ((pane as unknown as { activeDoorId?: string }).activeDoorId ??
              undefined)
            : undefined;
          const choice = parentDoorId ? this.choiceFor(parentDoorId) : undefined;
          // 🧭 Mint the birth door's ID here, where the pairing that will name
          // it lives — an opaque d: uuid, not the wall label (which the axis
          // rename turned into 'x-'-style ids that the pairing read loop was
          // filtering out: the "no module connected" return bug).
          const birthDoorId = choice
            ? `d:${crypto.randomUUID().slice(0, 8)}`
            : undefined;
          // ⚓ #163: a staged, PAID mating half makes the new module a ship (or
          // station) docked by adapter — its birth door is born wearing that
          // half. The half goes to exactly ONE module: it is spent here (no
          // refund on unstaging, and a second provision from this door gets
          // none for free). Reserved before the await, so a double click can't
          // claim it twice; handed back if minting fails.
          const parentState = parentDoorId
            ? this.doorState.get(parentDoorId)
            : undefined;
          const mateForModule =
            !!choice &&
            !!parentState &&
            isDockChain(parentState.segments) &&
            parentState.dockMatePaid === true;
          if (mateForModule) parentState!.dockMatePaid = false;
          const seed = await this.provisionModuleCallback(
            templateId,
            parentDoorId,
            choice
              ? { ...choice, doorId: birthDoorId, port: mateForModule }
              : undefined,
          );
          if (!seed && mateForModule && parentState) {
            // Not spent after all. Back on the door while it still stages an
            // UNPAID mate (the one reserved); otherwise — unstaged meanwhile,
            // or re-staged with a freshly paid half — back in stock, so a
            // reserved half is never lost.
            if (isDockChain(parentState.segments) && !parentState.dockMatePaid) {
              parentState.dockMatePaid = true;
            } else {
              refundPart("adapter");
            }
          }
          // 🧭 The pairing this address is about to INITIATE already knows the
          // far side exactly — it is the door we just chose. Stash it so the
          // published record is fully described from birth, no walk-through
          // needed. (The birth door's id IS its wall name — seedDoorLayoutSingle.)
          if (seed && parentDoorId && choice) {
            const st = this.doorState.get(parentDoorId);
            if (st) {
              st.farDoor = birthDoorId;
              st.farWall = choice.wall;
              st.farLateral = choice.lateral;
            }
          }
          const addrInput = document.getElementById(
            "docking-addr-input",
          ) as HTMLInputElement | null;
          if (seed && addrInput) {
            addrInput.value = seed;
          } else if (!seed) {
            alert("Could not mint a module seed — is the local node running?");
          }
        } finally {
          provisionBtn.disabled = false;
          provisionBtn.textContent = originalLabel;
        }
      });
    }

    // Initiate pairings
    if (requestBtn) {
      requestBtn.addEventListener("click", () => {
        const pane = document.getElementById("docking-control-pane");
        const activeDoorId = pane ? (pane as any).activeDoorId : null;
        if (!activeDoorId) return;
        const state = this.doorState.get(activeDoorId);
        const addrInput = document.getElementById(
          "docking-addr-input",
        ) as HTMLInputElement | null;
        const pinInput = document.getElementById(
          "docking-pin-input",
        ) as HTMLInputElement | null;

        // #67 D1/D2: construction rights per the door's policy — EXCEPT at a
        // docking-adapter PORT, where anyone may berth a ship.
        // ⚓ #163: a port door connects ONLY by docking, for everyone: the
        // connection is a DOCK — this door's half plus the far door's (staged
        // here as the mating half, or brought by the visiting ship) — always
        // transient and stamped. The old guest berth was exactly this door
        // with a plain gangway; it is round now.
        // The dock chain itself is assigned only after the gates below pass —
        // a refused INITIATE must not leave a ghost tunnel on the door.
        const willDock = this.doorHasPort(activeDoorId);
        // A port door connects only by docking — and a staged mating half on
        // a door whose port was removed meanwhile (by a peer, while this pane
        // sat open) must not go out as a dock with no port behind it.
        const chainRefusal = initiateChainRefusal(willDock, state?.segments);
        if (chainRefusal) {
          alert(chainRefusal);
          return;
        }
        if (!willDock) {
          if (!this.canConstruct(activeDoorId)) {
            alert(
              "No construction rights on this port — ask the owner (REQUEST BUILD RIGHTS below).",
            );
            return;
          }
          if (state) {
            state.transient = false; // rights-holder pairing = permanent structure
            state.dockedAt = undefined;
          }
        }
        if (activeDoorId) this.untouchedPrefills.delete(activeDoorId); // INITIATE = intentional
        if (state && addrInput && pinInput) {
          state.connectedRoomAddress = addrInput.value.trim();
          state.pinCode = pinInput.value.trim();

          if (!state.connectedRoomAddress) {
            alert("Please paste a target room seed link first!");
            return;
          }

          // 🚪 ONE VESTIBULE PER DOOR — both ends, before the request goes out.
          // THIS door: a live pairing to some other module must be UNDOCKED
          // first. The DOC record, not the local state — a peer may have paired
          // it while this pane sat open. The FAR door: whatever the atlas knows
          // to be connected already, on the far room's own record or as another
          // room's far end, is refused here (the arrival refuses it too, but by
          // then the near record is published and the tube is drawn).
          {
            // ⚓ #163: this one door, read itself — never through the capped
            // snapshot, which could hide a live dock that doorHasPort sees.
            const own = readDoor(activeDoorId);
            if (
              own?.paired &&
              own.connectedRoomAddress &&
              own.connectedRoomAddress !== state.connectedRoomAddress
            ) {
              alert(
                "This door already has a vestibule — UNDOCK it before connecting it somewhere else.",
              );
              return;
            }
            const farRid = roomIdFromSeed(state.connectedRoomAddress);
            const currentRid =
              (window as unknown as { __ssfRoomId?: string }).__ssfRoomId ?? "";
            const taken = farRid
              ? this.farDoorTakenBy(farRid, state.farDoor, state.farWall, state.farLateral)
              : null;
            // Exempt only THIS door's own existing connection (re-initiating
            // it). Another door of this same room counts as taken — otherwise
            // two of our doors would share one far door (review, round 3).
            const ours =
              taken?.roomId === currentRid && taken.doorId === activeDoorId;
            if (taken && !ours) {
              const name =
                taken.roomId === currentRid
                  ? "another door of this module"
                  : (readAtlas()[taken.roomId]?.name ?? "another module");
              alert(
                `That door of the target module already has a vestibule (to ${name}). Pick a free door, or re-route the chain to another wall.`,
              );
              return;
            }
          }

          // ⚓ #163: every gate above passed — a port door's connection IS a
          // dock from here on (the overlap gate below poses the module at the
          // dock's length). A clash refusal puts the working chain back.
          const chainBefore = state.segments;
          if (willDock) {
            state.segments = dockChain();
            state.transient = true;
            // Causally after this port's own last undock (a re-dock by
            // INITIATE must not read as a stale berth to the far mirror).
            const prior = classifyDockPort(readDoor(activeDoorId));
            state.dockedAt = stampAfter(
              prior.kind === "undocked" ? prior.memory.undockedAt : undefined,
            );
          }

          // 🛰️ #28 S6a: BLOCK a pairing whose module would dock ON TOP of an
          // existing station module (the WARN's hard-stop half). Only when a
          // chain projects the module, and only for a cardinal berth (the pose
          // helper is cardinal-only); the connect target within the match radius
          // is excluded by moduleOverlapAt. Keys off ports/atlas, never doors.
          if (state.segments && state.segments.length > 0) {
            const currentId =
              (window as unknown as { __ssfRoomId?: string }).__ssfRoomId ?? "";
            // The SAME pose the final projection and atlasLayout use — far
            // wall, lateral AND the target's true half-extent — or the gate
            // tests a centre metres from where the module will be drawn
            // (reviews, rounds 7 and 9).
            const gateWall = this.farWallFor(state);
            const gateDims = readAtlas()[roomIdFromSeed(state.connectedRoomAddress)]?.dims;
            const clash = currentId
              ? moduleOverlapAt(
                  currentId,
                  projectionPoseForDoor(
                    activeDoorId,
                    state.segments,
                    gateWall,
                    state.farLateral ?? 0,
                    gateWall ? halfAlongWall(gateDims, gateWall) : undefined,
                  ),
                )
              : null;
            if (clash) {
              if (willDock) state.segments = chainBefore;
              alert(
                `Can't dock here — the module would overlap ${clash.name}. Re-route the connector chain to a clear berth.`,
              );
              return;
            }
          }

          state.pairingPending = true;
          state.inboundRequest = false; // ours — INITIATE, not a peer's request
          this.syncLEDStatus(activeDoorId, state);

          if (this.onConnectionRequestCallback) {
            this.onConnectionRequestCallback(
              activeDoorId,
              state.connectedRoomAddress,
            );
          }
          // #62 P4: modules this client minted pair instantly when auto-accept
          // is on — no far-side human exists for a freshly provisioned room.
          if (this.autoAcceptCheckCallback?.(state.connectedRoomAddress)) {
            this.completePairing(activeDoorId, true);
            console.log(
              `🤝 Auto-accepted pairing on ${activeDoorId} (own minted module).`,
            );
          }
          // The hypothesis dies with the pane on EVERY hide path — a ghost
          // (+ room shell + wide framing) left behind here had no pane to
          // dismiss it until the next pane-open repaint.
          this.removeProvisionGhost();
          if (box) box.style.display = "none";
        }
      });
    }

    // Accept / Reject inbound pairings
    if (acceptBtn) {
      acceptBtn.addEventListener("click", () => {
        const pane = document.getElementById("docking-control-pane");
        const activeDoorId = pane ? (pane as any).activeDoorId : null;
        if (!activeDoorId) return;
        // #67 D1: approving a docking follows construction rights.
        if (!this.canConstruct(activeDoorId)) {
          alert(
            "No construction rights on this port — ask the owner (REQUEST BUILD RIGHTS below).",
          );
          return;
        }
        this.completePairing(activeDoorId, true);
        this.removeProvisionGhost(); // hypothesis dies with the pane
        if (box) box.style.display = "none";
      });
    }

    if (rejectBtn) {
      rejectBtn.addEventListener("click", () => {
        const pane = document.getElementById("docking-control-pane");
        const activeDoorId = pane ? (pane as any).activeDoorId : null;
        if (!activeDoorId) return;
        this.completePairing(activeDoorId, false);
        this.removeProvisionGhost(); // hypothesis dies with the pane
        if (box) box.style.display = "none";
      });
    }

    // ── 🪧 DOOR SIGN wiring ─────────────────────────────────────────────────
    // `change` (not `input`): one doc write when the field is committed —
    // Enter or blur — rather than one per keystroke, which would spam every
    // peer's reconcile and rebuild the plaque texture on each letter.
    const labelInput = document.getElementById(
      "docking-label-input",
    ) as HTMLInputElement | null;
    labelInput?.addEventListener("change", () => {
      const pane = document.getElementById("docking-control-pane");
      const doorId = pane ? ((pane as any).activeDoorId as string | null) : null;
      if (!doorId || !this.canConstruct(doorId)) return;
      const label = sanitizeDoorLabel(labelInput.value);
      labelInput.value = label ?? ""; // show what was actually stored
      // SEED-FIRST (the editMode drag rule): the layout reconcile removes any
      // door not in the map, so writing one record into an UNSEEDED room would
      // erase the other three cardinals. Idempotent.
      seedDoorLayoutDefaults();
      // writeDoorLabel, not a read-modify-write through readAllDoorLayout:
      // that is a read-NORMALIZER (size, lateral, the cardinal compat shim),
      // so round-tripping a record through it to change a label would write
      // the door's geometry fields back too. See its doc comment.
      writeDoorLabel(doorId, label);
    });

    // 🧭 F2c (redo review): manually editing the target address invalidates a
    // CONNECT-stashed far geometry — it described the PREVIOUS target, and a
    // subsequent INITIATE to a different module must not publish it.
    (
      document.getElementById("docking-addr-input") as HTMLInputElement | null
    )?.addEventListener("input", () => {
      const doorId = activeDoor();
      const st = doorId ? this.doorState.get(doorId) : null;
      if (!st || st.pairedSuccessfully) return;
      st.farWall = undefined;
      st.farLateral = undefined;
      // …the far door ID too: it named a door of the PREVIOUS target, and a
      // stale id is exactly what the arrival must never be handed — left in
      // place it would ride the published record to module B as if it had
      // been chosen there (review, round 4). The select falls back to auto.
      st.farDoor = undefined;
      const farSel = document.getElementById(
        "docking-far-door",
      ) as HTMLSelectElement | null;
      if (farSel) farSel.value = "";
      // …and the FAR options follow the new target's real door set.
      if (doorId) this.renderFarDoorOptions(doorId);
    });

    // ── 🧭 NEW-MODULE PLACEMENT wiring (⟳ / ◀ ▶ + live ghost) ───────────────
    const placeRotate = document.getElementById("docking-place-rotate");
    const placeLat = document.getElementById("docking-place-lat");
    const paintPlacement = (doorId: string) => {
      const c = this.choiceFor(doorId);
      // 🧭 Degrees, not walls — the ghost shows the orientation; the button
      // reports how far the module is turned FROM THIS DOOR'S DEFAULT (the
      // default wall varies by near-wall kind now, so absolute indices
      // would open some panes at "90°" untouched).
      const order: DoorWall[] = ["x-", "y-", "x+", "y+"];
      const base = order.indexOf(this.defaultBirthWall(doorId));
      if (placeRotate)
        placeRotate.textContent = `⟳ ${((order.indexOf(c.wall) - base + 4) % 4) * 90}°`;
      if (placeLat)
        placeLat.textContent =
          c.lateral === 0
            ? "CENTRE"
            : `${c.lateral > 0 ? "+" : ""}${c.lateral} m`;
      this.updateProvisionGhost(doorId);
    };
    // expose for handlePanelRaycast (defined in this closure, used there via a
    // stashed reference — the pane is a singleton, same trick as activeDoorId)
    this.paintPlacement = paintPlacement;
    placeRotate?.addEventListener("click", () => {
      const doorId = activeDoor();
      if (!doorId || !this.canConstruct(doorId)) return;
      const c = this.choiceFor(doorId);
      const order: DoorWall[] = ["x-", "y-", "x+", "y+"];
      c.wall = order[(order.indexOf(c.wall) + 1) % 4];
      paintPlacement(doorId);
    });
    const shift = (d: number) => {
      const doorId = activeDoor();
      if (!doorId || !this.canConstruct(doorId)) return;
      const c = this.choiceFor(doorId);
      // ±4 — the same corner clearance the door editor enforces on a 2×2 room.
      c.lateral = Math.max(-4, Math.min(4, c.lateral + d));
      paintPlacement(doorId);
    };
    document
      .getElementById("docking-place-left")
      ?.addEventListener("click", () => shift(-1));
    document
      .getElementById("docking-place-right")
      ?.addEventListener("click", () => shift(1));

    // ── #62 P4: CONNECTION ASSEMBLY wiring ──────────────────────────────────
    const activeDoor = (): string | null => {
      const pane = document.getElementById("docking-control-pane");
      return pane ? ((pane as any).activeDoorId ?? null) : null;
    };

    document
      .getElementById("docking-add-flex")
      ?.addEventListener("click", () => {
        const doorId = activeDoor();
        const state = doorId ? this.doorState.get(doorId) : null;
        if (!doorId || !state || !this.canConstruct(doorId)) return;
        // ⚓ #163: a port door connects by docking only.
        const refusal = gangwayPartRefusal(this.doorHasPort(doorId));
        if (refusal) {
          this.showAssemblyNotice(doorId, refusal);
          return;
        }
        this.untouchedPrefills.delete(doorId); // deliberate edit — chain is intentional now
        if (!consumePart("flex")) {
          this.renderAssemblyStrip(doorId, "no FLEX parts — DEV menu › PARTS");
          return;
        }
        state.segments = [
          ...(state.segments ?? []),
          { kind: "flex", bendDeg: 0, stretch: 0 },
        ];
        this.renderAssemblyStrip(doorId);
        this.publishIfPaired(doorId);
      });

    document
      .getElementById("docking-add-ext")
      ?.addEventListener("click", () => {
        const doorId = activeDoor();
        const state = doorId ? this.doorState.get(doorId) : null;
        if (!doorId || !state || !this.canConstruct(doorId)) return;
        const refusal = gangwayPartRefusal(this.doorHasPort(doorId));
        if (refusal) {
          this.showAssemblyNotice(doorId, refusal);
          return;
        }
        this.untouchedPrefills.delete(doorId);
        if (!consumePart("ext")) {
          this.renderAssemblyStrip(
            doorId,
            "no EXTENSION parts — DEV menu › PARTS",
          );
          return;
        }
        state.segments = [
          ...(state.segments ?? []),
          { kind: "ext", bays: 4, skin: "solid" },
        ];
        this.renderAssemblyStrip(doorId);
        this.publishIfPaired(doorId);
      });

    document
      .getElementById("docking-clear-chain")
      ?.addEventListener("click", () => {
        const doorId = activeDoor();
        const state = doorId ? this.doorState.get(doorId) : null;
        if (!doorId || !state || !this.canConstruct(doorId)) return;
        // ⚓ A live dock's halves are not a working chain — UNDOCK releases
        // them. (CLEAR on a paired door would republish an EMPTY chain and
        // turn a round dock into a plain gangway.)
        if (state.pairedSuccessfully && isDockChain(state.segments)) {
          this.showAssemblyNotice(doorId, "Docked — use ⏏ UNDOCK above to release it.");
          return;
        }
        this.untouchedPrefills.delete(doorId);
        this.refundWorkingChain(state);
        state.segments = undefined;
        this.renderAssemblyStrip(doorId);
        this.publishIfPaired(doorId);
      });

    // ⚓ #163 +DOCK — the docking-adapter vestibule option. First press fits
    // THIS door's round port (a door fitting: shared, survives any dock);
    // second press stages the MATING half the connection will bring to the far
    // door — then PROVISION NEW MODULE for a new independent ship or station,
    // or pick a target and INITIATE. dockRules.nextDockStep decides.
    document
      .getElementById("docking-add-dock")
      ?.addEventListener("click", () => {
        const doorId = activeDoor();
        const state = doorId ? this.doorState.get(doorId) : null;
        if (!doorId || !state) return;
        if (!this.canConstruct(doorId)) {
          this.showAssemblyNotice(doorId, "No build rights on this door — a port can only be fitted by its owner.");
          return;
        }
        const step = nextDockStep({
          hasPort: this.doorHasPort(doorId),
          record: readDoor(doorId),
          staged: state.segments,
        });
        if (step.kind === "refuse") {
          this.showAssemblyNotice(doorId, step.reason);
          return;
        }
        if (!consumePart("adapter")) {
          this.renderAssemblyStrip(doorId, "no ADAPTER parts — DEV menu › PARTS");
          return;
        }
        this.untouchedPrefills.delete(doorId);
        if (step.kind === "fit-port") {
          // SEED-FIRST is not needed here: writeDoorPolicy refuses a door the
          // layout does not know, and every door with a pane is known.
          writeDoorPolicy(doorId, { ...readDoorPolicy(doorId), adapter: true });
        } else {
          state.segments = dockChain();
          state.dockMatePaid = true;
        }
        this.assemblyNotice = null;
        this.renderAssemblyStrip(doorId);
        this.renderDockRow(doorId);
        this.notifyDockChange();
      });

    // Chip interactions (delegated): cycle the main parameter, toggle skin,
    // or remove (with refund).
    document.getElementById("docking-chips")?.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-chip-action]",
      );
      if (!el) return;
      const doorId = activeDoor();
      const state = doorId ? this.doorState.get(doorId) : null;
      const i = Number(el.dataset.i);
      if (
        !doorId ||
        !state ||
        !state.segments ||
        !Number.isInteger(i) ||
        !state.segments[i]
      )
        return;
      if (!this.canConstruct(doorId)) return;
      // ⚓ Dock halves have their own chips (data-dock-chip) — never cycled,
      // skinned or refunded as gangway parts here.
      if (state.segments[i].kind === "dock") return;
      this.untouchedPrefills.delete(doorId);
      const seg = { ...state.segments[i] };
      const action = el.dataset.chipAction;
      if (action === "remove") {
        refundPart(seg.kind === "flex" ? "flex" : "ext");
        state.segments = state.segments.filter((_, k) => k !== i);
        if (state.segments.length === 0) state.segments = undefined;
      } else if (action === "cycle") {
        if (seg.kind === "flex") {
          const bends = [-45, -22.5, 0, 22.5, 45];
          const at = bends.indexOf(seg.bendDeg ?? 0);
          seg.bendDeg = bends[(at + 1 + bends.length) % bends.length];
        } else {
          const bays = [2, 4, 6, 8, 11];
          const at = bays.indexOf(seg.bays ?? 4);
          seg.bays = bays[(at + 1 + bays.length) % bays.length];
        }
        state.segments = state.segments.map((s, k) => (k === i ? seg : s));
      } else if (action === "skin" && seg.kind === "ext") {
        seg.skin = seg.skin === "solid" ? "ribbed" : "solid";
        state.segments = state.segments.map((s, k) => (k === i ? seg : s));
      }
      this.renderAssemblyStrip(doorId);
      this.publishIfPaired(doorId);
    });

    // ⚓ #163: the dock chips — ✕ on the PORT removes this door's half
    // (refund; refused while docked, and it closes the remembered berth), ✕ on
    // the MATING HALF unstages it (refund).
    document.getElementById("docking-chips")?.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-dock-chip]");
      if (!el) return;
      const doorId = activeDoor();
      const state = doorId ? this.doorState.get(doorId) : null;
      if (!doorId || !state || !this.canConstruct(doorId)) return;
      if (this.dockOp(doorId)?.busy) return; // a dock/undock is running
      const record = readDoor(doorId);
      if (el.dataset.dockChip === "unstage-mate") {
        if (state.pairedSuccessfully || !isDockChain(state.segments)) return;
        this.refundWorkingChain(state);
        state.segments = undefined;
      } else if (el.dataset.dockChip === "remove-port") {
        const port = classifyDockPort(record);
        if (port.kind === "docked") {
          this.showAssemblyNotice(doorId, "Docked — UNDOCK before removing the port.");
          return;
        }
        // A staged mating half has nothing to mate with any more.
        if (isDockChain(state.segments) && !state.pairedSuccessfully) {
          this.refundWorkingChain(state);
          state.segments = undefined;
        }
        if (readDoorPolicy(doorId).adapter) refundPart("adapter");
        // Removing the port CLOSES the berth: the tombstone keeps refusing
        // the old dock's mirror, but loses its memory, so neither this door's
        // DOCK nor the far side's may re-make the connection (dockRules
        // farDockPatch reads a plain tombstone naming it — or any tombstone
        // on a door without a port — as "closed"). ONE transaction: a far
        // room's DOCK session reading this room never sees the port gone
        // while the old berth memory still stands.
        transactDoorWrites(() => {
          writeDoorPolicy(doorId, { ...readDoorPolicy(doorId), adapter: false });
          if (port.kind === "undocked") writeDoorTombstone(doorId, port.address);
        });
      }
      this.assemblyNotice = null;
      this.renderAssemblyStrip(doorId);
      this.renderDockRow(doorId);
      this.notifyDockChange();
    });

    // ⚓ #163 DOCK row actions (delegated — the row re-renders on every change).
    document.getElementById("docking-dock-row")?.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-dock-action]");
      if (!el) return;
      const doorId = activeDoor();
      if (!doorId) return;
      if (el.dataset.dockAction === "undock") void this.undockPort(doorId);
      else if (el.dataset.dockAction === "dock") void this.redockPort(doorId);
    });

    (
      document.getElementById("docking-far-door") as HTMLSelectElement | null
    )?.addEventListener("change", (e) => {
      const doorId = activeDoor();
      const state = doorId ? this.doorState.get(doorId) : null;
      if (!doorId || !state || !this.canConstruct(doorId)) return;
      const v = (e.target as HTMLSelectElement).value;
      // Any real door id from the per-target options ('' = auto). The old
      // four-name filter silently discarded a free `d:` selection to auto —
      // exactly the class of cardinal gate this rename exists to end.
      state.farDoor = v || undefined;
      // 🧭 The stashed farWall/farLateral described the PREVIOUS far door —
      // clearing them makes farWallFor re-resolve from the atlas for the new
      // one instead of republishing a confidently wrong wall to every client.
      state.farWall = undefined;
      state.farLateral = undefined;
      this.publishIfPaired(doorId);
    });

    document
      .getElementById("docking-far-yaw")
      ?.addEventListener("click", () => {
        const doorId = activeDoor();
        const state = doorId ? this.doorState.get(doorId) : null;
        if (!doorId || !state || !this.canConstruct(doorId)) return;
        // Cycle — → 0 → 45 → —
        state.farYawDeg =
          state.farYawDeg === undefined
            ? 0
            : state.farYawDeg === 0
              ? 45
              : undefined;
        this.renderAssemblyStrip(doorId);
        this.publishIfPaired(doorId);
      });

    // 🗺️ Known-modules picker → fills the address input (repopulated on
    // every pane open by renderKnownModules).
    document
      .getElementById("docking-known-modules")
      ?.addEventListener("change", (e) => {
        const sel = e.target as HTMLSelectElement;
        const addrInput = document.getElementById(
          "docking-addr-input",
        ) as HTMLInputElement | null;
        if (sel.value && addrInput) {
          addrInput.value = sel.value;
          addrInput.style.borderColor = "rgba(0,230,118,0.7)";
          setTimeout(() => {
            addrInput.style.borderColor = "";
          }, 1600);
        }
        sel.selectedIndex = 0; // reads as a menu, not a state
      });

    // ── #67 D1/D1b: DOOR POLICY actions (delegated) ─────────────────────────
    document
      .getElementById("docking-policy-body")
      ?.addEventListener("click", (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>(
          "[data-policy-action]",
        );
        if (!el) return;
        const doorId = activeDoor();
        if (!doorId) return;
        const action = el.dataset.policyAction;
        const pub = el.dataset.pub ?? "";
        if (action === "req-build") {
          // Any player may ASK (that is the point) — their own client writes it.
          writeDoorRequest(doorId, getIdentityPub(), getPlayerName());
        } else if (action === "detach-berth") {
          // #67 D2: EITHER side casts off a transient berth — no owner ceremony.
          // The doc delete reconciles to every client (projection torn down,
          // door re-locked) through the normal doors-doc path.
          deleteDoorPairing(doorId);
        } else if (!this.isRoomOwner()) {
          return; // every action below is owner-only (UI gate, dev-phase posture)
        } else if (action === "cycle-passage") {
          // 🚪↦ Four states: PUBLIC (two-way) → IN ONLY → OUT ONLY → OWNER → …
          const p = readDoorPolicy(doorId);
          const next: DoorPolicyRecord = { ...p };
          if (p.passage === "owner") {
            next.passage = "public";
            delete next.oneWay;
          } else if (!p.oneWay) {
            next.oneWay = "in";
          } else if (p.oneWay === "in") {
            next.oneWay = "out";
          } else {
            next.passage = "owner";
            delete next.oneWay;
          }
          writeDoorPolicy(doorId, next);
        } else if (action === "cycle-construction") {
          const p = readDoorPolicy(doorId);
          const next: Record<ConstructionMode, ConstructionMode> = {
            owner: "request",
            request: "public",
            public: "owner",
          };
          writeDoorPolicy(doorId, { ...p, construction: next[p.construction] });
        } else if (action === "slide-neg" || action === "slide-pos") {
          // 🧱 Slide the door one grid cell along its wall. Owner-only (this
          // branch), UNPAIRED-only (plan §6.2 — live chains never re-solve).
          // 🚪 #18: EVERY door, one write path — the record. The cardinal-only
          // gate existed because this control drove the retired floorPlan
          // slide store; with the record the sole position, the free-door
          // keypad finally gets the nudge buttons too.
          const st2 = this.doorState.get(doorId);
          if (st2?.pairedSuccessfully) return;
          seedDoorLayoutDefaults(); // seed-first — same rule as every door edit
          const rec = readAllDoorLayout().get(doorId);
          if (!rec) return; // door vanished under the open pane
          const wallLimit = doorLateralLimitForWall(rec.wall);
          const stepped = Math.max(
            -wallLimit,
            Math.min(
              wallLimit,
              Math.round(rec.lateral) + (action === "slide-pos" ? 1 : -1),
            ),
          );
          // Same gate the drag editor's drop uses (fold review F1): without
          // it a couple of nudges could park a door inside a wall-mate's
          // opening, a window cut or a furniture band, persisting an overlap
          // the editor would have refused — the drag and the slider must
          // agree on what a legal spot is.
          if (!validateDoorPlacement(rec.wall, stepped, doorId).ok) return;
          writeDoorLayout({ ...rec, lateral: stepped, placed: true });
          // The record is the sole position — clear legacy slide residue, or
          // the read-boundary fold re-adds the old drag on top (door jump).
          clearDoorSlide(doorId);
        } else if (action === "undock-module") {
          // ⏏ Owner removes a PERMANENT docked module (transient berths have
          // their own DETACH row above the owner gate). Two-click arm/confirm.
          // The doc delete reconciles everywhere through the normal doors-doc
          // path (clearRemotePairing): projection torn down, door re-locked.
          // The module's room doc survives on the node — re-dock its address
          // to get it back.
          const stu = this.doorState.get(doorId);
          if (!stu?.pairedSuccessfully || stu.transient) return;
          if (this.undockArmed.get(doorId) === stu.connectedRoomAddress) {
            this.undockArmed.delete(doorId);
            // ⏏ #91: TOMBSTONE, not delete — the far room's mirror record still
            // points here and would re-pair this door on the next walk-through
            // back, silently undoing the undock. It names the retired module so
            // it refuses only that one. See writeDoorTombstone.
            writeDoorTombstone(doorId, stu.connectedRoomAddress);
          } else {
            // arm FOR this pairing — a different armed address is stale
            this.undockArmed.set(doorId, stu.connectedRoomAddress);
          }
        } else if (action === "accept-req" && pub) {
          writeDoorGrant(doorId, pub, el.dataset.name ?? "Unknown-Clone");
        } else if (action === "deny-req" && pub) {
          removeDoorRequest(doorId, pub);
        } else if (action === "revoke-grant" && pub) {
          removeDoorGrant(doorId, pub);
        }
        this.renderPolicySection(doorId);
        if (isCardinalDoorId(doorId)) this.renderAssemblyStrip(doorId); // a grant/mode change may unlock the strip
      });
  }

  /** #67 D1/D1b: paint the DOOR POLICY section (policy cycles for the owner;
   *  summary + request flow for guests; live request/grant lists). */
  private renderPolicySection(doorId: string): void {
    const body = document.getElementById("docking-policy-body");
    if (!body) return;
    const policy = readDoorPolicy(doorId);
    const owner = this.isRoomOwner();
    const myPub = getIdentityPub();
    const pill = `display:inline-block; padding:2px 8px; border-radius:6px; font-size:9px; font-weight:700; cursor:pointer; background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); color:#f0c060;`;
    const row = `display:flex; align-items:center; justify-content:space-between; gap:8px;`;
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

    // #67 D2: a live transient berth shows a DETACH row to EVERYONE — either
    // side may cast off a guest ship without owner ceremony.
    // ⚓ #163: only a LEGACY berth (a transient gangway from before docks were
    // round) — a dock has its own DOCK row with UNDOCK at the top of the pane.
    const st = this.doorState.get(doorId);
    const detachRow =
      st?.pairedSuccessfully && st.transient && !isDockChain(st.segments)
        ? `<div style="${row}"><span style="color:#80d8ff;">⛴ TRANSIENT BERTH · ship docked</span>
           <button type="button" data-policy-action="detach-berth" style="${pill} background:rgba(255,23,68,0.10); border-color:rgba(255,23,68,0.35); color:#ff8a80;">⏏ DETACH</button></div>`
        : "";

    // ⏏ Owner-only UNDOCK for a PERMANENT docked module (the transient berth
    // has its own everyone-visible DETACH row above). Destructive → two-click
    // arm/confirm. The module's room doc survives on the node; re-docking its
    // address restores it.
    // The arm is only live while the SAME permanent pairing it was set for
    // still exists — drop it the moment the pairing is removed, turns
    // transient, or swaps to a different module under the open pane.
    if (
      this.undockArmed.has(doorId) &&
      (!st?.pairedSuccessfully ||
        st.transient ||
        this.undockArmed.get(doorId) !== st.connectedRoomAddress)
    ) {
      this.undockArmed.delete(doorId);
    }
    const undockArmed = this.undockArmed.has(doorId);
    const undockRow =
      st?.pairedSuccessfully && !st.transient
        ? `<div style="${row}"><span style="color:${undockArmed ? "#ff8a80" : "rgba(212,168,75,0.7)"};">${
            undockArmed
              ? "⚠ REALLY UNDOCK? Module detaches from the station (its data survives — re-dock the address to restore)"
              : `🧩 DOCKED MODULE <span style="color:rgba(212,168,75,0.4);" title="${esc(st.connectedRoomAddress)}">· ${esc(st.connectedRoomAddress.slice(0, 10))}…</span>`
          }</span>
           <button type="button" data-policy-action="undock-module" style="${pill} background:rgba(255,23,68,${undockArmed ? "0.25" : "0.10"}); border-color:rgba(255,23,68,${undockArmed ? "0.7" : "0.35"}); color:#ff8a80;">${undockArmed ? "⏏ CONFIRM" : "⏏ UNDOCK"}</button></div>`
        : "";

    // 🚪 #18: POSITION nudges for EVERY door — the last cardinal-gated
    // control. The readout is the record's along-wall centre.
    const positionRow = `<div style="${row}"><span>🧱 POSITION <span style="color:rgba(212,168,75,0.4);">· slide along wall${st?.pairedSuccessfully ? " — unpair first" : ""}</span></span>
          <span style="flex-shrink:0; display:flex; gap:4px; align-items:center;">
            <button type="button" data-policy-action="slide-neg" ${st?.pairedSuccessfully ? "disabled" : ""} style="${pill}">◀</button>
            <span style="font-size:9px; color:rgba(212,168,75,0.6); min-width:34px; text-align:center;">${(() => {
              const recs = readAllDoorLayout();
              const l = (recs.size ? recs : defaultDoorLayoutRecords()).get(doorId)?.lateral ?? 0;
              return l === 0 ? "CENTRE" : `${l > 0 ? "+" : ""}${l.toFixed(1)}m`;
            })()}</span>
            <button type="button" data-policy-action="slide-pos" ${st?.pairedSuccessfully ? "disabled" : ""} style="${pill}">▶</button>
          </span></div>`;
    // ⚓ #163: the docking adapter moved OUT of this collapsed section — it is a
    // vestibule now, fitted with +DOCK in the connection assembly (its chip ✕
    // removes it) and docked/undocked from the DOCK row at the top of the pane.
    // Same per-door `adapter` flag, so every port installed from here before
    // is simply a port.

    if (owner) {
      const requests = readDoorRequests(doorId);
      const grants = readDoorGrants(doorId);
      const reqRows = requests
        .map(
          (r) => `
        <div style="${row}">
          <span style="color:#ffb300; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="key ${esc(r.requesterPub)}">⚠ ${esc(r.requesterName)} <span style="color:rgba(212,168,75,0.4);">${esc(r.requesterPub.slice(0, 8))}</span></span>
          <span style="flex-shrink:0; display:flex; gap:4px;">
            <button type="button" data-policy-action="accept-req" data-pub="${esc(r.requesterPub)}" data-name="${esc(r.requesterName)}" style="${pill} background:rgba(0,230,118,0.15); border-color:rgba(0,230,118,0.4); color:#00e676;">ACCEPT</button>
            <button type="button" data-policy-action="deny-req" data-pub="${esc(r.requesterPub)}" style="${pill} background:rgba(255,23,68,0.10); border-color:rgba(255,23,68,0.35); color:#ff8a80;">DENY</button>
          </span>
        </div>`,
        )
        .join("");
      const grantRows = grants
        .map(
          (g) => `
        <div style="${row}">
          <span style="color:#00e676; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="key ${esc(g.pub)}">✔ ${esc(g.name)} <span style="color:rgba(212,168,75,0.4);">${esc(g.pub.slice(0, 8))}</span></span>
          <button type="button" data-policy-action="revoke-grant" data-pub="${esc(g.pub)}" style="${pill} background:rgba(255,23,68,0.10); border-color:rgba(255,23,68,0.35); color:#ff8a80;">REVOKE</button>
        </div>`,
        )
        .join("");
      // 🔑 PASSAGE is the room's ACCESS control, and this panel is where it
      // lives (owner ruling). It does two things at once and the label now says
      // so: it decides who may WALK THROUGH (canPass), and — because a room is
      // reachable exactly when some door admits strangers — whether the room's
      // dial-in SEED is published to the station at all. Setting every door to
      // OWNER makes the module unlisted. It never hides the module's OUTSIDE:
      // size, position and connections gossip unconditionally, by design.
      const anyPublic = [...readAllDoorLayout().keys()]
        .some((id) => readDoorPolicy(id).passage === "public");
      const reachNote = anyPublic
        ? `<div style="font-size:9px; color:rgba(212,168,75,0.45); line-height:1.35; margin:-2px 0 2px;">🔑 A public door publishes this room's dial-in address. Its outside — size, position, connections — is visible to everyone either way.</div>`
        : `<div style="font-size:9px; color:#80d8ff; line-height:1.35; margin:-2px 0 2px;">🔒 UNLISTED — no door admits strangers, so this room's address is not published. Its outside stays visible; only entry is closed.</div>`;
      body.innerHTML = `
        <div style="${row}"><span>PASSAGE <span style="color:rgba(212,168,75,0.4);">· who may walk through${policy.oneWay ? " · one-way for guests" : ""}</span></span>
          <button type="button" data-policy-action="cycle-passage" style="${pill}">${passageLabel(policy)}</button></div>
        ${reachNote}
        <div style="${row}"><span>CONSTRUCTION <span style="color:rgba(212,168,75,0.4);">· dock/build</span></span>
          <button type="button" data-policy-action="cycle-construction" style="${pill}">${policy.construction.toUpperCase()}</button></div>
        ${positionRow}
        ${undockRow}
        ${detachRow}
        ${requests.length ? `<div style="font-size:9px; font-weight:800; color:rgba(255,179,0,0.7); letter-spacing:1px; margin-top:2px;">RIGHTS REQUESTS</div>${reqRows}` : ""}
        ${grants.length ? `<div style="font-size:9px; font-weight:800; color:rgba(0,230,118,0.6); letter-spacing:1px; margin-top:2px;">STANDING GRANTS</div>${grantRows}` : ""}
      `;
    } else {
      const granted = hasDoorGrant(doorId, myPub);
      const requested = hasDoorRequest(doorId, myPub);
      const buildLine =
        policy.construction === "public"
          ? '<span style="color:#00e676;">BUILD: PUBLIC</span>'
          : policy.construction === "request"
            ? granted
              ? '<span style="color:#00e676;">✔ BUILD RIGHTS GRANTED</span>'
              : requested
                ? '<span style="color:#ffb300;">⏳ RIGHTS REQUESTED — awaiting the owner</span>'
                : `<button type="button" data-policy-action="req-build" style="${pill} background:rgba(255,179,0,0.12); border-color:rgba(255,179,0,0.4); color:#ffb300;">🙋 REQUEST BUILD RIGHTS</button>`
            : '<span style="color:rgba(212,168,75,0.55);">BUILD: OWNER ONLY</span>';
      body.innerHTML = `
        <div style="${row}"><span>PASSAGE: ${passageLabel(policy)}</span>${buildLine}</div>
        ${
          // ⚓ #163: any door (the cardinal-only gate here was a leftover) —
          // a port is a berth any visitor may dock a ship at.
          policy.adapter && !this.canConstruct(doorId)
            ? `<div style="color:#f2efe6;">⚓ DOCK PORT — enter your ship's address above and INITIATE to dock it here</div>`
            : ""
        }
        ${detachRow}
      `;
    }
  }

  /**
   * 🧭 Fill the FAR select with the TARGET module's real doors, numbered with
   * the same perimeter rule every other surface speaks. Target = the address
   * box (pre-INITIATE) or the live pairing. A module the atlas has no door
   * geometry for offers only "auto" — which is never wrong: the mirror names
   * the actual arrival door on the first walk-through.
   */
  private renderFarDoorOptions(doorId: string): void {
    const farSel = document.getElementById(
      "docking-far-door",
    ) as HTMLSelectElement | null;
    if (!farSel) return;
    const st = this.doorState.get(doorId);
    const addr =
      (document.getElementById("docking-addr-input") as HTMLInputElement | null)
        ?.value || st?.connectedRoomAddress || "";
    const rid = addr ? roomIdFromSeed(addr) : "";
    const doors = rid ? readAtlas()[rid]?.doors ?? {} : {};
    const currentId =
      (window as unknown as { __ssfRoomId?: string }).__ssfRoomId ?? "";
    // 🚪 ONE VESTIBULE PER DOOR: the atlas lists a far room's doors BECAUSE
    // they are paired (that is how it learns them), so every entry here is an
    // occupied berth unless it is THIS door's own existing connection (being
    // re-initiated) — another door of this room is a second vestibule too
    // (review, round 3). That reciprocity is decided from THIS door's own
    // live record — paired to that room, naming that door by id or by wall +
    // lateral — never from the peer record's farDoor, which may be a stale
    // compass guess that happens to name the open door (review, round 9).
    // Offered greyed-out and unselectable, never as a target — this list used
    // to be exactly the set of doors that must not take a second vestibule.
    const ownRec = readDoor(doorId); // ⚓ #163: uncapped, like every named-door read
    const ownTarget =
      ownRec?.paired && ownRec.connectedRoomAddress
        ? roomIdFromSeed(ownRec.connectedRoomAddress)
        : "";
    const reciprocal = (id: string, d: { wall?: DoorWall; lateral?: number } | undefined): boolean =>
      !!ownRec?.paired &&
      ownTarget === rid &&
      (ownRec.farDoor === id ||
        (!!ownRec.farWall &&
          ownRec.farWall === d?.wall &&
          Math.abs((ownRec.farLateral ?? 0) - (d?.lateral ?? 0)) < MIN_DOOR_GAP));
    const entries = Object.entries(doors).map(([id, d]) => ({
      id, wall: d?.wall, lateral: d?.lateral,
      inUse: !!d?.targetRoomId && !(d.targetRoomId === currentId && reciprocal(id, d)),
    }));
    const ordinals = doorOrdinals(entries);
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const prev = farSel.value;
    farSel.innerHTML =
      `<option value="">auto</option>` +
      entries
        .sort((a, b) => (ordinals.get(a.id) ?? 9) - (ordinals.get(b.id) ?? 9))
        .map((e) =>
          `<option value="${esc(e.id)}"${e.inUse ? " disabled" : ""}>DOOR ${ordinals.get(e.id)}${e.inUse ? " · in use" : ""}</option>`)
        .join("");
    // Keep the current selection when it survives the repopulation; a farDoor
    // naming a door the atlas does not list yet degrades to auto IN THE UI
    // while the state keeps the precise id (the mirror wrote it). A selection
    // that turned out to be in use degrades to auto too.
    farSel.value = prev;
    if (farSel.value !== prev || entries.find((e) => e.id === prev)?.inUse)
      farSel.value = "";
  }

  /** #67: re-paint policy + assembly for the OPEN pane (doc-change refresh —
   *  a grant landing while a guest stares at the keypad unlocks it live). */
  public refreshPolicyUI(): void {
    // ⚓ The helm's docking computer listens too — a port fitted, a dock made
    // or released anywhere in the room repaints it, pane open or not.
    this.notifyDockChange();
    const pane = document.getElementById("docking-control-pane");
    if (!pane || pane.style.display === "none") return;
    const doorId = (pane as any).activeDoorId as string | null;
    if (!doorId) return;
    this.renderPolicySection(doorId);
    // ⚓ Every door, not just cardinals: the strip shows a door's PORT, which a
    // policy change (a port fitted from another client) can add or remove.
    this.renderAssemblyStrip(doorId);
    this.renderDockRow(doorId);
  }

  /** #62 P4: paint the assembly strip from the door's working chain. */
  private renderAssemblyStrip(doorId: string, note?: string): void {
    const state = this.doorState.get(doorId);
    const chips = document.getElementById("docking-chips");
    const partsNote = document.getElementById("docking-parts-note");
    const farSel = document.getElementById(
      "docking-far-door",
    ) as HTMLSelectElement | null;
    const yawBtn = document.getElementById("docking-far-yaw");
    if (!state || !chips) return;
    const segs = state.segments ?? [];
    // 🛰️ Hull-space honesty (the other direction of hull.ts's mount check):
    // warn when THIS chain's fold sweeps through mounted exterior equipment.
    const chainClash = (() => {
      if (segs.length === 0) return null;
      for (const cb of this.chainBoxesFor(doorId)) {
        for (const it of exteriorItemBoxes()) {
          if (
            cb.x0 < it.box.x1 &&
            cb.x1 > it.box.x0 &&
            cb.z0 < it.box.z1 &&
            cb.z1 > it.box.z0
          ) {
            return it.id;
          }
        }
      }
      return null;
    })();
    // 🛰️ #28 S2: warn when the module this chain would project lands ON an
    // existing station module (a footprint overlap with a DIFFERENT, farther
    // module — the connect target within 4.5 m is excluded). Advisory here;
    // the docking BLOCK arrives with the free-door editor (S6).
    const moduleClash = (() => {
      if (segs.length === 0) return null;
      const currentId =
        (window as unknown as { __ssfRoomId?: string }).__ssfRoomId ?? "";
      if (!currentId) return null;
      // Same pose the final projection uses — far wall, lateral AND the
      // target's true half-extent — or the warning validates a module metres
      // from where it will be drawn (reviews, rounds 7 and 9).
      const warnWall = this.farWallFor(state);
      const warnDims = state.connectedRoomAddress
        ? readAtlas()[roomIdFromSeed(state.connectedRoomAddress)]?.dims
        : undefined;
      const wouldBe = projectionPoseForDoor(
        doorId, segs, warnWall, state.farLateral ?? 0,
        warnWall ? halfAlongWall(warnDims, warnWall) : undefined,
      );
      const hit = moduleOverlapAt(currentId, wouldBe);
      return hit ? hit.name : null;
    })();
    const escName = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    // ⚓ #163: a door wearing a dock port shows the ADAPTER, not a chain: the
    // port chip (this door's half) and the mating half — staged, or mated
    // with the far door's when docked. White, like the adapter itself.
    const dockChip = (text: string, action?: string, title?: string) => `
            <span style="display:inline-flex; align-items:center; gap:4px; background:rgba(242,239,230,0.10); border:1px solid rgba(242,239,230,0.45); border-radius:10px; padding:2px 8px; font-size:9px; font-weight:700; color:#f2efe6;"${title ? ` title="${escName(title)}"` : ""}>
              ⚓ ${text}
              ${action ? `<button type="button" data-dock-chip="${action}" title="Remove (refunds the part)" style="background:none; border:none; color:#ff8a80; font-size:9px; cursor:pointer; padding:0 1px;">✕</button>` : ""}
            </span>`;
    const hasPort = this.doorHasPort(doorId);
    const docked = state.pairedSuccessfully && isDockChain(segs);
    const mateStaged = !state.pairedSuccessfully && isDockChain(segs);
    const mayEdit = this.canConstruct(doorId);
    const notice =
      this.assemblyNotice?.doorId === doorId
        ? `<div style="font-size:9px; color:#FFB300; margin-top:4px;">⚠ ${escName(this.assemblyNotice.text)}</div>`
        : "";
    const warnings =
      (chainClash
        ? `<div style="font-size:9px; color:#FFB300; margin-top:4px;">⚠ chain sweeps through mounted equipment (${chainClash}) — bend around it or move the mount</div>`
        : "") +
      (moduleClash
        ? `<div style="font-size:9px; color:#FF7043; margin-top:4px;">⛔ would overlap <b>${escName(moduleClash)}</b> — this module can't dock here; re-route the chain</div>`
        : "");
    if (hasPort || mateStaged) {
      chips.innerHTML =
        dockChip(
          "PORT · this door",
          mayEdit && !docked ? "remove-port" : undefined,
          docked ? "UNDOCK before removing the port" : "This door's half of the docking adapter",
        ) +
        (docked
          ? dockChip("MATED · far door's half", undefined, "Both halves locked together — UNDOCK releases them")
          : mateStaged
            ? dockChip("MATING HALF · far door", mayEdit ? "unstage-mate" : undefined, "The half this dock brings to the far door")
            : `<span style="font-size:9px; color:rgba(242,239,230,0.45);">${
                mayEdit
                  ? "+DOCK again adds the other half — then PROVISION NEW MODULE, or INITIATE to a module with a port"
                  : "a ship docks here with its own half — INITIATE below"
              }</span>`) +
        warnings +
        notice;
    } else chips.innerHTML =
      (segs.length === 0
        ? `<span style="font-size:9px; color:rgba(212,168,75,0.35);">no chain — a plain pairing uses the straight gangway · +DOCK fits a round docking port</span>`
        : segs
            .map((s, i) => {
              const label =
                s.kind === "flex"
                  ? `FLEX ${(s.bendDeg ?? 0) > 0 ? "+" : ""}${s.bendDeg ?? 0}°`
                  : `EXT ×${s.bays ?? 4}`;
              const skinBtn =
                s.kind === "ext"
                  ? `<button type="button" data-chip-action="skin" data-i="${i}" title="Toggle skin" style="background:none; border:none; color:rgba(212,168,75,0.7); font-size:8px; cursor:pointer; padding:0 2px;">${s.skin === "solid" ? "SOLID" : "RIBBED"}</button>`
                  : "";
              return `
            <span style="display:inline-flex; align-items:center; gap:4px; background:rgba(212,168,75,0.10); border:1px solid rgba(212,168,75,0.3); border-radius:10px; padding:2px 8px; font-size:9px; font-weight:700;">
              <button type="button" data-chip-action="cycle" data-i="${i}" title="Click to cycle ${s.kind === "flex" ? "bend" : "length"}" style="background:none; border:none; color:#f0c060; font-size:9px; font-weight:700; cursor:pointer; padding:0;">${label}</button>
              ${skinBtn}
              <button type="button" data-chip-action="remove" data-i="${i}" title="Remove (refunds the part)" style="background:none; border:none; color:#ff8a80; font-size:9px; cursor:pointer; padding:0 1px;">✕</button>
            </span>`;
            })
            .join("") + warnings) + notice;
    if (partsNote) {
      partsNote.textContent =
        note ??
        (this.canConstruct(doorId)
          ? `· stock F×${partsCount("flex")} E×${partsCount("ext")} A×${partsCount("adapter")}`
          : readDoorPolicy(doorId).construction === "request"
            ? "· no build rights — REQUEST below"
            : "· owner only on this port");
    }
    this.renderFarDoorOptions(doorId);
    // Restore the state's far door onto the select only when its option is
    // there AND enabled: a programmatic assignment selects a DISABLED option
    // just as happily, which showed an in-use door as chosen after the
    // options had marked it so (review, round 5). Otherwise the UI reads auto
    // while the state keeps its precise id (the mirror may have written it).
    if (farSel) {
      const opt = state.farDoor
        ? [...farSel.options].find((o) => o.value === state.farDoor)
        : undefined;
      farSel.value = opt && !opt.disabled ? state.farDoor! : "";
    }
    if (yawBtn)
      yawBtn.textContent = `YAW ${state.farYawDeg === undefined ? "—" : state.farYawDeg}`;
    // ⚓ A port door connects by docking: the gangway parts dim (a click
    // still explains why), and +DOCK says what its next press does.
    for (const id of ["docking-add-flex", "docking-add-ext"]) {
      const b = document.getElementById(id);
      if (!b) continue;
      b.style.opacity = hasPort ? "0.35" : "1";
      b.title = hasPort ? (gangwayPartRefusal(true) ?? "") : "";
    }
    const dockBtn = document.getElementById("docking-add-dock");
    if (dockBtn) {
      const step = nextDockStep({
        hasPort,
        record: readDoor(doorId),
        staged: state.segments,
      });
      dockBtn.style.opacity = step.kind === "refuse" || !mayEdit ? "0.35" : "1";
      dockBtn.title =
        step.kind === "fit-port"
          ? "Fit this door's half of a docking adapter — a round port (1 ADAPTER part)"
          : step.kind === "stage-mate"
            ? "Add the OTHER half — the one the module on the far side will wear (1 ADAPTER part)"
            : step.reason;
    }
    // 🧲 Every chain edit re-tests whether the far end now reaches a known
    // module — the connect prompt appears/disappears as you build.
    this.detectChainContact(doorId);
    // …and carries the placement ghost with it: the ghost sits at the chain's
    // END, so every +FLEX/+EXT/chip edit moves where the module would land.
    if (this.provisionGhost) this.updateProvisionGhost(doorId);
  }

  // ── ⚓ #163: dock ports, DOCK and UNDOCK ────────────────────────────────────

  /** Does this door wear a dock port? Its policy flag — or a live dock, which
   *  always has both halves whatever a lagging policy map says. */
  public doorHasPort(doorId: string): boolean {
    return isPortDoor(readDoorPolicy(doorId).adapter === true, readDoor(doorId));
  }

  /** May the local player dock / undock at this door? The door's own
   *  construction rights — the same gate as building a connection there. */
  public canOperateDock(doorId: string): boolean {
    return this.canConstruct(doorId);
  }

  private showAssemblyNotice(doorId: string, text: string): void {
    this.assemblyNotice = { doorId, text };
    this.renderAssemblyStrip(doorId);
  }

  /** Refund what the WORKING chain cost: gangway parts one per segment; for a
   *  staged dock only the mating half, and only if it was paid for (+DOCK) —
   *  the port is a door fitting with its own refund, and an INITIATE-made
   *  dock chain (the far ship brings its half) cost nothing. */
  private refundWorkingChain(state: DockingState): void {
    const segs = state.segments ?? [];
    if (segs.length > 0 && segs.every((s) => s.kind === "dock")) {
      if (state.dockMatePaid) refundPart("adapter");
    } else if (segs.length > 0) {
      refundForSegments(segs);
    }
    state.dockMatePaid = false;
  }

  /** Register for dock-port changes (the helm's docking computer). */
  public onDockChange(cb: () => void): () => void {
    this.dockListeners.add(cb);
    return () => this.dockListeners.delete(cb);
  }

  private notifyDockChange(): void {
    for (const listener of [...this.dockListeners]) {
      try {
        listener();
      } catch (err) {
        console.error("[docking] dock listener threw:", err);
      }
    }
  }

  /** The room this client stands in. */
  private roomNow(): string {
    return (window as unknown as { __ssfRoomId?: string }).__ssfRoomId ?? "";
  }

  /** This room's operation on `doorId`. Operations are keyed by room AND door:
   *  this system outlives room swaps, and door ids repeat from room to room —
   *  a note (or a busy flag) from `north` in one room must never show on, or
   *  lock, `north` in the next. */
  private dockOp(doorId: string) {
    return this.dockOps.get(`${this.roomNow()}|${doorId}`);
  }

  /** Record an operation's state for `doorId` in `roomId` — the room the
   *  operation STARTED in, which an await may since have left. */
  private setDockOp(
    doorId: string,
    op: { busy?: boolean; note?: string; tone?: "ok" | "warn" | "bad" },
    roomId = this.roomNow(),
  ): void {
    this.dockOps.set(`${roomId}|${doorId}`, { busy: op.busy ?? false, note: op.note, tone: op.tone });
    const pane = document.getElementById("docking-control-pane");
    if (
      roomId === this.roomNow() &&
      pane &&
      pane.style.display !== "none" &&
      (pane as unknown as { activeDoorId?: string }).activeDoorId === doorId
    ) {
      this.renderDockRow(doorId);
      this.renderAssemblyStrip(doorId);
    }
    this.notifyDockChange();
  }

  /** The module on the other side, by name when the atlas knows it. */
  private partnerLabel(roomId: string): string {
    const name = roomId ? readAtlas()[roomId]?.name : undefined;
    return name && name !== "Module" ? name : "the other module";
  }

  /** This door's along-wall centre, in the currency pairing records use. */
  private doorLateral(doorId: string): { wall: DoorWall; lateral: number } {
    const pose = this.poseForDoor(doorId);
    return { wall: pose.wall, lateral: pose.tangent === "x" ? pose.x : pose.z };
  }

  /** Every dock port of the room, in door order — the helm's list and map. */
  public listDockPorts(): DockPortView[] {
    // An AUTHORITATIVE door set is the whole truth, even when it is empty
    // ("this room has no doors"); only an un-migrated room stands on the four
    // defaults. (Removing a door leaves its policy behind, so resurrecting the
    // cardinals here would list a removed port as a phantom one.)
    const doors = doorSetIsAuthoritative()
      ? readAllDoorLayout()
      : defaultDoorLayoutRecords();
    const ids = [...doors.keys()];
    const ordinals = doorOrdinals([...doors.values()]);
    const out: DockPortView[] = [];
    for (const id of ids) {
      const record = readDoor(id);
      if (!isPortDoor(readDoorPolicy(id).adapter === true, record)) continue;
      const state = classifyDockPort(record);
      const partnerRoom =
        state.kind === "docked" || state.kind === "undocked" ? state.roomId : "";
      const op = this.dockOp(id);
      out.push({
        doorId: id,
        label: doorDisplayName(id),
        state,
        partnerName: partnerRoom ? this.partnerLabel(partnerRoom) : null,
        canOperate: this.canConstruct(id),
        busy: op?.busy ?? false,
        note: op?.note,
        tone: op?.tone,
      });
    }
    return out.sort(
      (a, b) => (ordinals.get(a.doorId) ?? 99) - (ordinals.get(b.doorId) ?? 99),
    );
  }

  /**
   * ⚓ The helm's SHIP ATLAS: every module connected to this one, posed in this
   * room's frame exactly as the gray-box projection poses it (the same pure
   * function, far wall, lateral and true half) — docks and gangways alike, so
   * the pilot sees what is bolted on (ship) and what is only docked (berth).
   */
  public connectedModules(): Array<{
    doorId: string;
    roomId: string;
    name: string;
    x: number;
    z: number;
    rotY: number;
    halfX: number;
    halfZ: number;
    dock: boolean;
  }> {
    const out: ReturnType<DoorDockingPortSystem["connectedModules"]> = [];
    for (const [doorId, st] of this.doorState) {
      if (!st.pairedSuccessfully || !st.connectedRoomAddress) continue;
      if (!this.doorObjects.has(doorId)) continue; // this room's doors only
      const roomId = roomIdFromSeed(st.connectedRoomAddress);
      const farWall = this.farWallFor(st);
      const dims = roomId ? readAtlas()[roomId]?.dims : undefined;
      const pose = projectionPoseForDoor(
        doorId,
        st.segments,
        farWall,
        st.farLateral ?? 0,
        farWall ? halfAlongWall(dims, farWall) : undefined,
      );
      out.push({
        doorId,
        roomId,
        name: this.partnerLabel(roomId),
        ...pose,
        ...moduleHalves(dims),
        dock: isDockChain(st.segments),
      });
    }
    return out;
  }

  /**
   * ⏏ UNDOCK — release a dock: the module on the far side is free to fly.
   * THIS side first (the tombstone keeps the berth memory, so DOCK can come
   * back), then the far room's end through the injected writer — best effort;
   * an unreachable far room is said, not hidden.
   */
  public async undockPort(doorId: string): Promise<boolean> {
    if (this.dockOp(doorId)?.busy) return false;
    // Every status this call reports belongs to the room it started in — the
    // far write is awaited, and the player may walk on meanwhile.
    const roomId = this.roomNow();
    const port = classifyDockPort(readDoor(doorId));
    if (port.kind !== "docked") return false;
    if (!this.canConstruct(doorId)) {
      this.setDockOp(doorId, {
        note: "Only this door's owner (or a builder here) can undock it.",
        tone: "bad",
      });
      return false;
    }
    // Causally after the dock it releases, whatever this client's clock says
    // (the far side's newer-dock guard and the mirror compare these stamps).
    const undockedAt = stampAfter(port.record.dockedAt);
    writeDoorTombstone(doorId, port.address, berthMemoryFrom(port.record, undockedAt));
    const name = this.partnerLabel(port.roomId);
    if (!this.farDockWriter) {
      this.setDockOp(doorId, {
        note: `Undocked from ${name}. Its side will show the dock until it undocks too.`,
        tone: "warn",
      });
      return true;
    }
    this.setDockOp(doorId, { busy: true, note: `Undocked — telling ${name}…` }, roomId);
    const near = this.doorLateral(doorId);
    let result: FarDockResult;
    try {
      result = await this.farDockWriter({
        kind: "undock",
        nearRoomId: roomId,
        farAddress: port.address,
        farDoor: port.record.farDoor,
        nearDoorId: doorId,
        nearWall: near.wall,
        nearLateral: near.lateral,
        undockedAt,
      });
    } catch (err) {
      console.warn("[dock] far undock threw:", err);
      result = { ok: false, reason: "unreachable" };
    }
    this.setDockOp(
      doorId,
      result.ok
        ? { note: `Undocked from ${name} — free to fly.`, tone: "ok" }
        : {
            note: `Undocked. ${name} could not be reached — its side shows the dock until it undocks too.`,
            tone: "warn",
          },
      roomId,
    );
    return true;
  }

  /**
   * ⚓ DOCK — re-make the dock this port remembers. The BERTH is asked first
   * (the far room's end, compare-and-swap: still free, still a port), so a
   * refused dock never flickers into existence; then this side. A far room
   * that cannot be reached docks this side alone — the first walk-through's
   * mirror completes it (dockRules.mirrorMayWrite: a dock newer than the
   * berth's undock re-docks). If this port changes while the berth is asked,
   * this side is left alone and the far write is taken back
   * (settleChangedRedock).
   */
  public async redockPort(doorId: string): Promise<boolean> {
    if (this.dockOp(doorId)?.busy) return false;
    // The room this DOCK belongs to: its status is reported there, and this
    // side is written only while the player still stands in it.
    const roomId = this.roomNow();
    const port = classifyDockPort(readDoor(doorId));
    if (port.kind !== "undocked" || !readDoorPolicy(doorId).adapter) return false;
    if (!this.canConstruct(doorId)) {
      this.setDockOp(doorId, {
        note: "Only this door's owner (or a builder here) can dock it.",
        tone: "bad",
      });
      return false;
    }
    const name = this.partnerLabel(port.roomId);
    const { farDoor, farWall, farLateral } = port.memory;
    // The same near-side gates INITIATE applies: the far door must not be
    // known to be taken, and the module must not land on another.
    const taken = this.farDoorTakenBy(port.roomId, farDoor, farWall, farLateral);
    if (taken && !(taken.roomId === roomId && taken.doorId === doorId)) {
      this.setDockOp(doorId, { note: FAR_DOCK_REFUSAL.occupied, tone: "bad" });
      return false;
    }
    if (roomId) {
      const dims = readAtlas()[port.roomId]?.dims;
      const clash = moduleOverlapAt(
        roomId,
        projectionPoseForDoor(
          doorId,
          dockChain(),
          farWall ?? null,
          farLateral ?? 0,
          farWall ? halfAlongWall(dims, farWall) : undefined,
        ),
      );
      if (clash) {
        this.setDockOp(doorId, {
          note: `Can't dock — ${name} would overlap ${clash.name}.`,
          tone: "bad",
        });
        return false;
      }
    }
    // Causally after the undock it replaces, whatever this client's clock
    // says — or the far side's walk-through mirror would read this deliberate
    // re-dock as a stale berth (dockRules.mirrorMayWrite) and never heal it.
    const dockedAt = stampAfter(port.memory.undockedAt);
    const near = this.doorLateral(doorId);
    // The far berth is asked over an await, and a peer may dock, re-connect or
    // strip this port meanwhile — or the player may walk into another room,
    // whose doc is the bound one now: this side is only ever written over the
    // very tombstone read above, in the room it was read in.
    const unchanged = () => {
      if (this.roomNow() !== roomId) return false;
      const now = classifyDockPort(readDoor(doorId));
      return now.kind === "undocked" && now.memory.undockedAt === port.memory.undockedAt;
    };
    let far: FarDockResult | null = null;
    if (this.farDockWriter && farDoor) {
      this.setDockOp(doorId, { busy: true, note: `Requesting the berth at ${name}…` }, roomId);
      try {
        far = await this.farDockWriter({
          kind: "dock",
          nearRoomId: roomId,
          replacesUndockedAt: port.memory.undockedAt,
          farAddress: port.address,
          farDoor,
          nearDoorId: doorId,
          nearWall: near.wall,
          nearLateral: near.lateral,
          dockedAt,
        });
      } catch (err) {
        console.warn("[dock] far dock threw:", err);
        far = { ok: false, reason: "unreachable" };
      }
      if (!far.ok && far.reason === "superseded") {
        // The berth already holds a dock of THIS very port, stamped after our
        // undock — made from the far side, or by a crew member here at the
        // same moment. That dock stands. Join it: this side takes that dock's
        // own stamp (exactly what the walk-through mirror would write), so
        // both ends hold one dock — and still only over the tombstone read
        // above, in the room it was read in.
        if (
          far.stamp !== undefined &&
          far.stamp > port.memory.undockedAt &&
          unchanged()
        ) {
          const joined = redockRecord(port, far.stamp);
          writeDoorPairing(doorId, joined.connectedRoomAddress, joined);
          this.setDockOp(
            doorId,
            { note: `Docked to ${name} — joining the dock already made to this port.`, tone: "ok" },
            roomId,
          );
          return true;
        }
        this.setDockOp(
          doorId,
          { note: `Another DOCK of this port reached ${name} at the same moment — that one stands.`, tone: "warn" },
          roomId,
        );
        return false;
      }
      if (!far.ok && (far.reason === "occupied" || far.reason === "closed" || far.reason === "gone")) {
        // A closed or vanished berth is not coming back: drop the memory so
        // this port stops offering it. An occupied one may free up.
        if (far.reason !== "occupied" && unchanged()) writeDoorTombstone(doorId, port.address);
        this.setDockOp(doorId, { note: FAR_DOCK_REFUSAL[far.reason], tone: "bad" }, roomId);
        return false;
      }
      if (!unchanged()) {
        return this.settleChangedRedock(doorId, port, far, {
          roomId,
          farDoor,
          dockedAt,
          near,
          name,
        });
      }
    }
    const next = redockRecord(port, dockedAt);
    writeDoorPairing(doorId, next.connectedRoomAddress, next);
    this.setDockOp(
      doorId,
      far?.ok
        ? { note: `Docked to ${name}.`, tone: "ok" }
        : {
            note: `Docked to ${name} on this side — it could not be told now; walking through completes it.`,
            tone: "warn",
          },
      roomId,
    );
    return true;
  }

  /**
   * ⚓ redockPort's far berth answered, but THIS port changed while it was
   * asked (a peer docked, re-connected or stripped it — or the player left
   * the room, so this side can no longer be written). Docked meanwhile to
   * this very berth under OUR stamp — a crew member here joining our dock, or
   * the walk-through mirror of our far write — both sides hold one dock and
   * nothing is taken back (dockRules.holdsOurRedock). Anything else, the far
   * side's own DOCK crossing ours included, would leave the berth holding a
   * dock this port does not have: take back exactly the far write this call
   * made (the far side undoes only a dock carrying our stamp, never anyone
   * else's), and say so.
   */
  private async settleChangedRedock(
    doorId: string,
    port: Extract<DockPortState, { kind: "undocked" }>,
    far: FarDockResult,
    ask: {
      roomId: string;
      farDoor: string;
      dockedAt: number;
      near: { wall: DoorWall; lateral: number };
      name: string;
    },
  ): Promise<boolean> {
    // Only the room this DOCK started in can say what its port holds now.
    const now =
      this.roomNow() === ask.roomId ? classifyDockPort(readDoor(doorId)) : null;
    if (holdsOurRedock(now, { roomId: port.roomId, farDoor: ask.farDoor }, ask.dockedAt)) {
      this.setDockOp(doorId, { note: `Docked to ${ask.name}.`, tone: "ok" }, ask.roomId);
      return true;
    }
    // Acknowledged, or made but never acknowledged (it may still land): either
    // way the berth may hold our write, and it is taken back.
    if (!farWriteMayStand(far) || !this.farDockWriter) {
      this.setDockOp(doorId, { note: "This port changed while docking — try again.", tone: "warn" }, ask.roomId);
      return false;
    }
    this.setDockOp(
      doorId,
      {
        busy: true,
        note: `This port changed while docking — releasing the berth at ${ask.name}…`,
      },
      ask.roomId,
    );
    let undone: FarDockResult;
    try {
      undone = await this.farDockWriter({
        kind: "undock",
        // The room the DOCK was made from — possibly not the one we stand in.
        nearRoomId: ask.roomId,
        farAddress: port.address,
        farDoor: ask.farDoor,
        nearDoorId: doorId,
        nearWall: ask.near.wall,
        nearLateral: ask.near.lateral,
        undockedAt: stampAfter(ask.dockedAt),
        onlyDockedAt: ask.dockedAt,
      });
    } catch (err) {
      console.warn("[dock] far take-back threw:", err);
      undone = { ok: false, reason: "unreachable" };
    }
    this.setDockOp(
      doorId,
      undone.ok
        ? {
            note: `This port changed while docking — the berth at ${ask.name} was released again. Try again.`,
            tone: "warn",
          }
        : {
            note: far.ok
              ? `This port changed while docking, and ${ask.name} could not be told to let go — its side shows the dock until it undocks.`
              : `This port changed while docking, and ${ask.name} could not be reached to let go — its side may show the dock until it undocks.`,
            tone: "bad",
          },
      ask.roomId,
    );
    return false;
  }

  /** ⚓ The DOCK row at the top of the pane (see its markup). */
  private renderDockRow(doorId: string): void {
    const rowEl = document.getElementById("docking-dock-row");
    if (!rowEl) return;
    const record = readDoor(doorId);
    if (!isPortDoor(readDoorPolicy(doorId).adapter === true, record)) {
      rowEl.style.display = "none";
      rowEl.innerHTML = "";
      return;
    }
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const port = classifyDockPort(record);
    const op = this.dockOp(doorId);
    const may = this.canConstruct(doorId);
    const btn = (action: "dock" | "undock", label: string, color: string) =>
      `<button type="button" data-dock-action="${action}" ${op?.busy ? "disabled" : ""} style="flex-shrink:0; border-radius:6px; border:1px solid ${color}; background:rgba(0,0,0,0.25); color:${color}; font-size:10px; font-weight:800; padding:5px 12px; cursor:${op?.busy ? "wait" : "pointer"}; opacity:${op?.busy ? "0.5" : "1"};">${label}</button>`;
    let status = "";
    let action = "";
    if (port.kind === "docked") {
      status = `⚓ DOCKED → <b>${esc(this.partnerLabel(port.roomId))}</b>`;
      if (may) action = btn("undock", "⏏ UNDOCK", "#ff8a80");
    } else if (port.kind === "undocked") {
      status = `⚓ UNDOCKED · last berth <b>${esc(this.partnerLabel(port.roomId))}</b>`;
      if (may) action = btn("dock", "⚓ DOCK", "#00e676");
    } else if (port.kind === "gangway") {
      status = "⚓ DOCK PORT · this door is connected by a gangway";
    } else {
      status = may
        ? "⚓ DOCK PORT · free — +DOCK stages the other half, or pick a target and INITIATE"
        : "⚓ DOCK PORT · free";
    }
    const toneColor =
      op?.tone === "ok" ? "#00e676" : op?.tone === "bad" ? "#ff8a80" : "#ffb300";
    rowEl.innerHTML = `
      <div style="border:1px solid rgba(242,239,230,0.35); border-radius:8px; padding:8px 10px; background:rgba(242,239,230,0.05); display:flex; flex-direction:column; gap:6px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
          <span style="font-size:10.5px; color:#f2efe6; line-height:1.35;">${status}</span>
          ${action}
        </div>
        ${op?.note ? `<div style="font-size:9.5px; color:${op.busy ? "#ffb300" : toneColor}; line-height:1.3;">${op.busy ? "⏳ " : ""}${esc(op.note)}</div>` : ""}
        ${!may && (port.kind === "docked" || port.kind === "undocked") ? `<div style="font-size:9px; color:rgba(242,239,230,0.5);">Docking here is up to the owner — or undock from your ship's own door or helm.</div>` : ""}
      </div>`;
    rowEl.style.display = "block";
  }

  /** #62 P4: a post-pairing chain edit re-fires the ACCEPTED publish so the
   *  record rewrites and every client's geometry diff picks it up. */
  private publishIfPaired(doorId: string): void {
    const state = this.doorState.get(doorId);
    if (state?.pairedSuccessfully && this.onPairingStatusChangedCallback) {
      this.onPairingStatusChangedCallback(doorId, "ACCEPTED");
    }
  }

  /**
   * Handle Click Raycasts originating in Three.js coordinates
   */
  /** 🚪 Close the pane AND kill the placement hypothesis (ghost + room shell
   *  + wide framing). The CLOSE button routes here, and so must every
   *  programmatic dismissal — this system is a SINGLETON across rooms, so a
   *  hypothesis left alive at leaveRoom would follow the player into the
   *  next room as a full-size orphaned shell with the camera still wide
   *  (adversarial review of the placement-context change, 2026-08-12). */
  public dismissPanel(): void {
    const pane = document.getElementById("docking-control-pane");
    const activeDoorId = pane ? ((pane as any).activeDoorId ?? null) : null;
    // Ghost-residue fix: closing without using the prefilled chain refunds it.
    if (activeDoorId) this.discardUntouchedPrefill(activeDoorId);
    this.removeProvisionGhost(); // the placement hypothesis dies with the pane
    if (pane) pane.style.display = "none";
  }

  public handlePanelRaycast(doorId: string) {
    const pane = document.getElementById("docking-control-pane");
    const title = document.getElementById("docking-pane-title");
    const lockBtn = document.getElementById("docking-lock-toggle");
    const pinInput = document.getElementById(
      "docking-pin-input",
    ) as HTMLInputElement | null;
    const addrInput = document.getElementById(
      "docking-addr-input",
    ) as HTMLInputElement | null;
    const noticeBox = document.getElementById("docking-pairing-box");

    if (!pane || !title || !lockBtn || !pinInput || !addrInput || !noticeBox)
      return;

    // Load active settings for this door
    const state = this.doorState.get(doorId);
    if (!state) return;

    // 🚪 EVERY door gets the full terminal now — connection assembly, target
    // address, provisioning and INITIATE (owner: "any door should allow a
    // vestibule or docking adapter"). These were hidden for free doors because
    // a pairing written under a `d:` id was unreadable: readAllDoors iterated a
    // fixed four-id list, so the record went onto the wire and was read by
    // nobody, including its own author after a rejoin. With that loop iterating
    // the map, a free-door pairing is as real as a cardinal one, and the
    // vestibule geometry never cared — it needs a pose, which every door has.
    const assemblyEl = document.getElementById("docking-assembly");
    const addrSection = addrInput.closest("div") as HTMLElement | null;
    const provisionTemplate = document.getElementById(
      "docking-provision-template",
    ) as HTMLElement | null;
    const provisionBtn = document.getElementById(
      "docking-provision-btn",
    ) as HTMLElement | null;
    const requestBtn = document.getElementById(
      "docking-request-btn",
    ) as HTMLElement | null;
    for (const el of [assemblyEl, addrSection, provisionTemplate, provisionBtn, requestBtn])
      if (el) el.style.display = "";

    // Expose active door context inside the modal scope
    (pane as any).activeDoorId = doorId;
    pane.style.display = "flex";
    // 🧭 A fresh pane starts from a fresh placement default: the memoized
    // choice would otherwise replay a default computed for ANOTHER room
    // (this system is a singleton across rooms and cardinal ids recur) or
    // for a wall the door has since been moved away from. Rotations made
    // while the pane is open still stick — they die with the pane.
    this.provisionChoice.delete(doorId);
    // 🧭 The door's NAME, never a wall: modules render at any angle, so
    // compass words are meaningless to the person reading this.
    title.textContent = `🚪 DOCKING PORT CONTROL: ${doorDisplayName(doorId)}`;

    // Set field states
    lockBtn.textContent = state.locked ? "LOCKED" : "UNLOCKED";
    lockBtn.style.background = state.locked ? "#ff1744" : "#00e676";
    lockBtn.style.color = state.locked ? "#fff" : "#01020a";
    pinInput.value = state.pinCode;
    addrInput.value = state.connectedRoomAddress;

    // 🪧 DOOR SIGN — every door, cardinal or free. Read-only without build
    // rights: signage is construction, so it follows the same gate as docking
    // and assembly rather than the (public-by-default) lock.
    const labelInput = document.getElementById(
      "docking-label-input",
    ) as HTMLInputElement | null;
    const labelNote = document.getElementById("docking-label-note");
    if (labelInput) {
      const mayLabel = this.canConstruct(doorId);
      labelInput.value = readAllDoorLayout().get(doorId)?.label ?? "";
      labelInput.readOnly = !mayLabel;
      labelInput.style.opacity = mayLabel ? "1" : "0.5";
      if (labelNote)
        labelNote.textContent = mayLabel
          ? "· what is on the other side"
          : "· no build rights on this door";
    }

    // If there is an active inbound pairing request, reveal target controls
    if (state.pairingPending && !state.pairedSuccessfully) {
      noticeBox.style.display = "flex";
    } else {
      noticeBox.style.display = "none";
    }

    // 🧭 NEW-MODULE placement editor: only meaningful while this berth could
    // still take a new module — hidden once paired (the real module replaced
    // the hypothesis) and for visitors without build rights.
    const placeRow = document.getElementById("docking-provision-place");
    const mayProvision =
      this.canConstruct(doorId) && !state.pairedSuccessfully;
    if (placeRow) placeRow.style.display = mayProvision ? "flex" : "none";
    if (mayProvision) this.paintPlacement?.(doorId);
    else this.removeProvisionGhost();

    {
      // #62 P4: armed-preset prefill — an unpaired door with no working chain
      // opens with the DEV-armed preset's chips already placed (parts consumed
      // atomically; silently skipped when stock is short). RING targets a
      // diamond ring room, so it defaults FAR yaw to 45. OWNER-only (vestibule
      // findings): a guest merely inspecting a keypad must not consume parts or
      // arm a ghost on someone else's room.
      if (
        this.canConstruct(doorId) &&
        !state.pairedSuccessfully &&
        (!state.segments || state.segments.length === 0) &&
        // ⚓ A port door connects by docking — never prefill a gangway there.
        !this.doorHasPort(doorId)
      ) {
        const preset = armedPreset();
        if (preset) {
          const segs = presetSegments(preset);
          if (consumeForSegments(segs)) {
            state.segments = segs;
            if (preset === "ring" && state.farYawDeg === undefined)
              state.farYawDeg = 45;
            this.untouchedPrefills.add(doorId); // refunded on close unless used
          }
        }
      }
      // ⚓ A fresh pane starts without a stale notice.
      this.assemblyNotice = null;
      this.renderAssemblyStrip(doorId);
      this.undockArmed.delete(doorId); // ⏏ arming never survives a pane re-open
      this.renderKnownModules(); // 🗺️ atlas picker
    }
    this.renderPolicySection(doorId); // #67 D1
    this.renderDockRow(doorId); // ⚓ #163
  }

  /**
   * 🧲 Chain-contact detection (owner's ask): fold the WORKING chain from
   * this door and test whether the module that would sit at its far end
   * coincides with a KNOWN module (the station atlas, laid out through the
   * connection graph — so closing the octagon matches room 1 via the path
   * around the ring). On contact: prompt right in the pane — CONNECT fills
   * the address + FAR door and fires the normal INITIATE path.
   * Works for modules the atlas can PLACE (reachable through known links);
   * an island module it has never seen connected can't be matched.
   */
  private detectChainContact(doorId: string): void {
    const slot = document.getElementById("docking-dock-detect");
    if (!slot) return;
    slot.style.display = "none";
    const state = this.doorState.get(doorId);
    if (
      !state ||
      state.pairedSuccessfully ||
      !state.segments ||
      state.segments.length === 0
    )
      return;
    const currentId =
      (window as unknown as { __ssfRoomId?: string }).__ssfRoomId ?? "";
    if (!currentId) return;

    // Where would a module sit at this chain's far end? (Room-local = world
    // for the current room — the same frame atlasLayout emits.)
    const wouldBe = projectionPoseForDoor(doorId, state.segments, null);
    const layout = atlasLayout(currentId, 8);
    let best: {
      roomId: string;
      name: string;
      seed?: string;
      dist: number;
      door: { id: string; wall: DoorWall; lateral: number };
      /** An OCCUPIED door that fit better than the pick — said in the prompt. */
      blocked?: { id: string; wall: DoorWall };
    } | null = null;
    /** The nearest module whose ONLY fitting door is already taken — the
     *  refusal the prompt explains instead of offering CONNECT. */
    let blockedOnly: { name: string; wall: DoorWall } | null = null;
    // The chain's END in this room's frame: the far module's centre sits
    // ROOM_HALF past it along the arrival heading (projectionPoseFromWall),
    // and with no far wall known the pose's rotY IS that heading.
    const heading = wouldBe.rotY;
    const arrival = {
      x: wouldBe.x - Math.sin(heading) * ROOM_HALF,
      z: wouldBe.z - Math.cos(heading) * ROOM_HALF,
      heading,
    };
    const atlas = readAtlas();
    // 🚪 Every door some room's record already LANDS ON, indexed by the far
    // room — ONE pass over the atlas per detection, not one per candidate
    // module (review F1: the atlas is peer-writable and this runs on every
    // chain edit). Entries are bounded at ingest — MAX_ENTRIES rooms of at most
    // MAX_DOORS_PER_ENTRY doors — so this is a small, fixed cost.
    const claimsByRoom = new Map<
      string,
      Array<{ id?: string; wall?: DoorWall; lateral?: number; from: string }>
    >();
    for (const [otherId, entry] of Object.entries(atlas)) {
      for (const od of Object.values(entry?.doors ?? {})) {
        if (!od?.targetRoomId) continue;
        let list = claimsByRoom.get(od.targetRoomId);
        if (!list) claimsByRoom.set(od.targetRoomId, (list = []));
        list.push({ id: od.farDoor, wall: od.farWall, lateral: od.farLateral, from: otherId });
      }
    }
    // A module's candidate doors (doorMatch.candidateFarDoors). Its REAL
    // gossiped doors, with a paired one KEPT and flagged occupied rather than
    // dropped — dropping it was the octagon bug: the wall-centre hypothetical
    // then re-offered the very wall the paired door sat on, and the closing
    // vestibule went onto a door that already had one. Plus every door some
    // OTHER room's record already lands on (its far end, by wall + lateral,
    // or by id when that is all it knows). Plus a wall-centre hypothetical for
    // each wall with no known door near its centre. Today the atlas learns
    // doors only FROM pairings, so the free real doors it will one day gossip
    // are the empty arm here; hypotheticals carry ring-closing until then.
    const candidateDoors = (roomId: string) => {
      const known: Array<{ id: string; wall?: DoorWall; lateral?: number; occupied: boolean }> = [];
      const claimedIds = new Set<string>();
      for (const [did, ad] of Object.entries(atlas[roomId]?.doors ?? {})) {
        if (!ad) continue;
        known.push({ id: did, wall: ad.wall, lateral: ad.lateral, occupied: !!ad.targetRoomId });
        if (ad.targetRoomId) claimedIds.add(did);
      }
      for (const claim of claimsByRoom.get(roomId) ?? []) {
        if (claim.from === roomId) continue; // its own records are the loop above
        if (claim.wall) {
          // A claim WITH geometry blocks by geometry, under a key of its own —
          // never its farDoor id, which may be a stale compass guess that the
          // target room hangs on another wall. Keyed by id it was deduplicated
          // away against the room's real door of that name, and the wall it
          // actually lands on came back as a free hypothetical (review, round 2).
          known.push({
            id: `claim:${claim.from}:${claim.wall}:${claim.lateral ?? 0}`,
            wall: claim.wall,
            lateral: claim.lateral ?? 0,
            occupied: true,
          });
        } else if (claim.id) {
          // No geometry — the id is all it knows, so it blocks by id.
          claimedIds.add(claim.id);
        }
      }
      const out = candidateFarDoors(known);
      for (const c of out) if (claimedIds.has(c.id)) c.occupied = true;
      return out;
    };
    // Reach: any face of a module lies within its half-diagonal of its
    // centre, so that (plus slack) is how far a module centre may sit from
    // the chain's END and still own the door the chain meets. The old filter
    // measured from `wouldBe`, which assumes a CENTRED far door, and so
    // rejected a module whose matching door sits 5 m along its wall — and
    // ranked by centre distance, which can prefer a worse face (review,
    // round 6). Modules are ranked by the face error the matcher returns.
    const ANG_W = 2 / (Math.PI / 3); // pickFacingDoor's own tie-break weight
    for (const layoutMod of layout) {
      // 🛑📐 The module's TRUE half-extents when the atlas learned them, else
      // the default 2×2 — the same rule the exterior renders with. Reach and
      // face positions both scale with it (review, round 7).
      const mod = { ...layoutMod, ...moduleHalves(layoutMod.dims) };
      // Half-diagonal plus the matcher's own face tolerance — the same
      // constant, so this coarse filter can never discard a module whose door
      // the matcher would have accepted (review, round 8).
      const reach = Math.hypot(mod.halfX, mod.halfZ) + FACE_MATCH_TOLERANCE;
      const dist = Math.hypot(mod.x - arrival.x, mod.z - arrival.z);
      if (dist > reach) continue;
      const cands = candidateDoors(mod.roomId);
      // Position first, angle as the fence and tie-break; never an occupied
      // door (doorMatch.pickFacingDoor).
      const pick = pickFacingDoor(mod, cands, arrival);
      if (pick) {
        const score = pick.posErr + pick.angErr * ANG_W;
        if (best && score >= best.dist) continue;
        best = {
          roomId: mod.roomId,
          name: mod.name,
          seed: mod.seed,
          dist: score,
          door: pick.door,
          blocked: pick.blockedBetter,
        };
      } else if (!blockedOnly) {
        // Would the chain have matched a door here if occupancy did not count?
        const ifFree = pickFacingDoor(
          mod,
          cands.map((c) => ({ ...c, occupied: false })),
          arrival,
        );
        if (ifFree) blockedOnly = { name: mod.name, wall: ifFree.door.wall };
      }
    }
    if (!best) {
      if (blockedOnly) {
        const esc = (s: string) =>
          s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
        slot.innerHTML = `
          <div style="border:1px solid rgba(255,23,68,0.35); border-radius:6px; padding:6px 10px; background:rgba(255,23,68,0.06); font-size:9.5px; color:#ff8a80;">
            🧲 CHAIN REACHES <b>${esc(blockedOnly.name)}</b>, but the door it lands on is already connected — one vestibule per door. Re-route the chain to a free wall.
          </div>`;
        slot.style.display = "block";
      }
      return;
    }
    if (!best.seed) return;

    // 🛬 JETBRIDGE FIT: solve the chain's free parameters (continuous bends,
    // flex + telescoping ext stretch) so the fold lands EXACTLY on the
    // matched module's door face — the owner's ruling: the chain adjusts to
    // reality (a 45° preset relaxes to 40°, bends equalize, the extension
    // slides). Target = the matched door's face, in this door's chain frame.
    const mod = layout.find((m) => m.roomId === best!.roomId)!;
    // The matched door's face in ITS module's local frame: on its wall, at its
    // lateral, at the module's TRUE half-extent (the matcher aimed there; the
    // solve must target the same face).
    const pick = best.door;
    const mh = moduleHalves(mod.dims);
    const doorFaceLocal =
      pick.wall === "y-" ? { x: pick.lateral, z: -mh.halfZ }
      : pick.wall === "y+" ? { x: pick.lateral, z: mh.halfZ }
      : pick.wall === "x+" ? { x: mh.halfX, z: pick.lateral }
      : { x: -mh.halfX, z: pick.lateral };
    const mc = Math.cos(mod.rotY),
      ms = Math.sin(mod.rotY);
    const faceWorld = {
      x: mod.x + doorFaceLocal.x * mc + doorFaceLocal.z * ms,
      z: mod.z - doorFaceLocal.x * ms + doorFaceLocal.z * mc,
    };
    // Chain frame: origin at OUR door face, +z outward, rotated by our door's
    // yaw — the door's LIVE pose, not a hardcoded wall-centre table, so a slid
    // cardinal or a free door anywhere on any wall solves correctly.
    const ourPose = this.poseForDoor(doorId);
    const ourYaw = ourPose.outwardYaw;
    const ourFace = { x: ourPose.x, z: ourPose.z };
    const dx = faceWorld.x - ourFace.x,
      dz = faceWorld.z - ourFace.z;
    const oc = Math.cos(-ourYaw),
      os = Math.sin(-ourYaw);
    const targetLocal = {
      x: dx * oc + dz * os,
      z: -dx * os + dz * oc,
      // Chain exit heading must point INTO the matched door.
      yawRad: mod.rotY + WALL_YAW[pick.wall] + Math.PI - ourYaw,
    };
    // Normalize the yaw into (-π, π].
    while (targetLocal.yawRad > Math.PI) targetLocal.yawRad -= Math.PI * 2;
    while (targetLocal.yawRad <= -Math.PI) targetLocal.yawRad += Math.PI * 2;
    const solved = solveChain(state.segments, targetLocal);
    const fits = solved.residualDist < 0.35 && solved.residualYawDeg < 4;

    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const fitNote = fits
      ? (() => {
          const bends = solved.segments
            .filter((s) => s.kind === "flex")
            .map((s) => `${(s.bendDeg ?? 0).toFixed(1)}°`)
            .join("/");
          return ` · auto-fit ${bends}`;
        })()
      : " · rigid (fit out of range)";
    // 🚪 Say when the natural door was skipped for being taken, so the owner
    // is not surprised by which door the tube goes to.
    const blockedNote = best.blocked
      ? " · its nearest door is already connected, using the next free one"
      : "";
    slot.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; border:1px solid rgba(0,230,118,0.35); border-radius:6px; padding:6px 10px; background:rgba(0,230,118,0.06);">
        <span style="flex:1; font-size:9.5px; color:#00e676;">🧲 CHAIN REACHES <b>${esc(best.name)}</b> — connect via its facing door?<span style="color:rgba(0,230,118,0.6);">${fitNote}${blockedNote}</span></span>
        <button type="button" id="docking-dock-connect" style="background:rgba(0,230,118,0.15); border:1px solid rgba(0,230,118,0.4); border-radius:5px; color:#00e676; font-size:9px; font-weight:800; padding:3px 10px; cursor:pointer;">CONNECT</button>
      </div>`;
    slot.style.display = "block";
    document
      .getElementById("docking-dock-connect")
      ?.addEventListener("click", () => {
        const st = this.doorState.get(doorId);
        // 🛬 Apply the SOLVED chain (exact fit) before pairing — the record
        // then carries the fitted geometry to every client.
        if (st && fits) {
          st.segments = solved.segments;
          this.renderAssemblyStrip(doorId);
        }
        const addr = document.getElementById(
          "docking-addr-input",
        ) as HTMLInputElement | null;
        const far = document.getElementById(
          "docking-far-door",
        ) as HTMLSelectElement | null;
        if (addr) addr.value = best!.seed!;
        if (far) far.value = best!.door.id; // no-op for a free id (4 options)
        if (st) {
          st.farDoor = best!.door.id;
          // 🧭 The matcher KNOWS the far wall — it just aimed the chain at it.
          // Stashing it (and the lateral) is what makes the published pairing
          // fully described before anyone ever walks through — and the WALL is
          // what the arrival trusts; for a hypothetical the id is only a name.
          st.farWall = best!.door.wall;
          st.farLateral = best!.door.lateral;
        }
        // Fire the normal INITIATE path (all its gates apply).
        document
          .getElementById("docking-request-btn")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
  }

  /** 🗺️ Repopulate the known-modules picker from the station atlas (every
   *  entry holding an address, current room excluded, most recent first). */
  private renderKnownModules(): void {
    const sel = document.getElementById(
      "docking-known-modules",
    ) as HTMLSelectElement | null;
    if (!sel) return;
    const currentId =
      (window as unknown as { __ssfRoomId?: string }).__ssfRoomId ?? "";
    const entries = Object.values(readAtlas())
      .filter((e) => e.seed && e.roomId !== currentId)
      // 🗄️ Same rule as atlas retention: first-hand rooms before gossip-only
      // ones. This list is SLICED to 24, so sorting it by the peer-written
      // `lastSeen` let a peer's fresh gossip crowd the player's own visited
      // modules out of the picker entirely (#144).
      .sort(compareAtlasRecency)
      .slice(0, 24);
    sel.innerHTML =
      '<option value="">🗺️ … or pick a KNOWN MODULE</option>' +
      entries
        .map((e) => {
          const esc = (s: string) =>
            s
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/"/g, "&quot;");
          return `<option value="${esc(e.seed!)}">${esc(e.name)} · ${esc(e.roomId.slice(0, 10))}</option>`;
        })
        .join("");
    sel.style.display = entries.length > 0 ? "block" : "none";
  }

  /** Refund + drop an untouched prefill chain (see untouchedPrefills docs). */
  private discardUntouchedPrefill(
    doorId: "north" | "south" | "east" | "west",
  ): void {
    if (!this.untouchedPrefills.delete(doorId)) return;
    const state = this.doorState.get(doorId);
    if (!state || state.pairedSuccessfully || !state.segments?.length) return;
    refundForSegments(state.segments);
    state.segments = undefined;
  }

  /**
   * Sync Status LED spheres in 3D coordinates based on locks and pairing
   * signals, and tint the emissive 'frameGlow' strips to match:
   * pending amber, paired green, locked red, otherwise cyan.
   */
  private syncLEDStatus(doorId: string, state: DockingState) {
    const group = this.doorObjects.get(doorId);
    if (!group) return;

    let ledColor = 0x1e88e5; // Blue (idle/unlocked)
    let glowColor = 0x00e5ff; // Cyan (idle/unlocked)
    if (state.pairingPending && !state.pairedSuccessfully) {
      ledColor = 0xffb300;
      glowColor = 0xffb300; // Yellow/Orange
    } else if (state.pairedSuccessfully) {
      ledColor = 0x00e676;
      glowColor = 0x00e676; // Green
    } else if (state.locked) {
      ledColor = 0xff1744;
      glowColor = 0xff1744; // Red
    }

    const led = group.getObjectByName("ledStatus") as THREE.Mesh | undefined;
    if (led && led.material instanceof THREE.MeshBasicMaterial) {
      led.material.color.setHex(ledColor);
    }

    group.traverse((child) => {
      if (child.name === "frameGlow") {
        const mat = (child as THREE.Mesh).material;
        if (mat instanceof THREE.MeshBasicMaterial) mat.color.setHex(glowColor);
      }
    });
  }

  /**
   * Execute inbound request triggers
   */
  public receiveInboundPairingRequest(
    doorId: "north" | "south" | "east" | "west",
    targetAddr: string,
  ) {
    const state = this.doorState.get(doorId);
    if (state) {
      state.connectedRoomAddress = targetAddr;
      state.pairingPending = true;
      // 🚪 A peer's request: only an address, never which of its doors — so it
      // can never prove it is this door's existing connection. completePairing
      // refuses it, accept or reject, while a live pairing sits on this door.
      state.inboundRequest = true;
      this.syncLEDStatus(doorId, state);

      // Start Flash LED animation inside tick
      this.animateBlinkingIndicator(doorId);
    }
  }

  private animateBlinkingIndicator(
    doorId: "north" | "south" | "east" | "west",
  ) {
    let toggle = false;
    const interval = setInterval(() => {
      const state = this.doorState.get(doorId);
      if (!state || !state.pairingPending || state.pairedSuccessfully) {
        clearInterval(interval);
        return;
      }

      const group = this.doorObjects.get(doorId);
      const led = group?.getObjectByName("ledStatus") as THREE.Mesh | undefined;
      if (led && led.material instanceof THREE.MeshBasicMaterial) {
        toggle = !toggle;
        led.material.color.setHex(toggle ? 0xffb300 : 0x111625); // flash yellow vs dark
      }
    }, 450);
  }

  public completePairing(
    doorId: "north" | "south" | "east" | "west",
    accept: boolean,
  ) {
    const state = this.doorState.get(doorId);
    if (!state) return;

    // 🚪 ONE VESTIBULE PER DOOR: a request that lands on a door with a LIVE
    // pairing may neither be accepted (that would overwrite the record) nor
    // rejected the ordinary way (the REJECTED publish deletes the door's
    // record — i.e. the EXISTING connection, not the request; review, round
    // 4). "Lands on a live pairing" means: a different module's address, OR
    // any INBOUND request at all — a peer's request carries only an address,
    // never which of its doors it is from, so a request from the same
    // module's OTHER door is indistinguishable from a refresh of this very
    // connection and must be refused too (review, round 6). Only our own
    // INITIATE to the same address (re-publishing geometry) may proceed.
    // Either way the existing connection is untouched: the local state is
    // restored from the record and the request simply cannot land here.
    {
      // ⚓ #163: this one door, read itself — the capped snapshot could hide
      // the live connection this guard exists to protect.
      const own = readDoor(doorId);
      if (
        own?.paired &&
        own.connectedRoomAddress &&
        (own.connectedRoomAddress !== state.connectedRoomAddress ||
          state.inboundRequest === true)
      ) {
        if (accept) {
          alert(
            "This door already has a vestibule to another module — undock it before accepting a new connection.",
          );
        }
        state.pairingPending = false;
        state.pairedSuccessfully = true;
        state.connectedRoomAddress = own.connectedRoomAddress;
        state.segments = own.segments;
        state.farDoor = own.farDoor;
        state.farWall = own.farWall;
        state.farLateral = own.farLateral;
        state.farYawDeg = own.farYawDeg;
        state.transient = own.transient === true;
        state.dockedAt = own.dockedAt;
        state.locked = false;
        this.syncLEDStatus(doorId, state);
        return;
      }
    }

    state.pairingPending = false;
    state.pairedSuccessfully = accept;

    if (accept) {
      // ⚓ A staged mating half is spent: it went with the far door.
      state.dockMatePaid = false;
      this.removeProvisionGhost(); // the real module replaces the hypothesis
      state.locked = false; // Open door on success
      // 🧭 Best-effort far wall at pairing time: the atlas may already gossip
      // the far room's door geometry (someone stood there and harvested it).
      // Resolved BEFORE the publish below fires, so the record leaves this
      // client fully described when it can; the first walk-through's mirror
      // fills it in when it cannot.
      if (!state.farWall) state.farWall = this.farWallFor(state) ?? undefined;
      this.syncLEDStatus(doorId, state);
      this.drawAdjacentRoomProjection(doorId);
      this.openDoor(doorId);
    } else {
      state.connectedRoomAddress = "";
      // Vestibule-findings fix (ghost residue): a REJECTED connection's working
      // chain must not linger as a ghost tube on an unpaired door — refund the
      // parts and drop it. The far geometry goes with it — it described the
      // connection that was just refused (F2, redo review).
      // ⚓ A dock chain refunds only a PAID mating half (refundWorkingChain).
      this.refundWorkingChain(state);
      state.segments = undefined;
      state.dockedAt = undefined;
      state.farDoor = undefined;
      state.farWall = undefined;
      state.farLateral = undefined;
      this.syncLEDStatus(doorId, state);
    }

    if (this.onPairingStatusChangedCallback) {
      this.onPairingStatusChangedCallback(
        doorId,
        accept ? "ACCEPTED" : "REJECTED",
      );
    }
  }

  /**
   * #64: apply a pairing ANOTHER user in the room made, delivered via the shared
   * `doors` doc. Mirrors completePairing's accept branch (open door, draw the
   * adjacent-module projection, mark paired so transitReady passes) but does NOT
   * fire onPairingStatusChanged — that callback publishes to the doc, and a remote
   * apply must never re-publish (it would loop). Idempotent: re-applying the same
   * pairing is a no-op (drawAdjacentRoomProjection guards on adjacentRooms.has).
   */
  public applyRemotePairing(
    doorId: string,
    address: string,
    geometry?: {
      segments?: ConnectorSegment[];
      farDoor?: string;
      farWall?: DoorWall;
      farLateral?: number;
      farYawDeg?: 0 | 45;
      transient?: boolean;
      dockedAt?: number;
    },
  ): void {
    // 🚪 CREATE the state when it is missing rather than silently dropping the
    // pairing (repro'd owner bug, 2026-08-11: module round trip). The door
    // STATE map is a singleton across rooms, and entering another room removes
    // this room's door groups — removeDoorGroup deletes their states with
    // them. On the way back the sync burst fires the doors observer BEFORE the
    // layout observer, so this ran against a deleted state and no-opped; the
    // layout reconcile then rebuilt the door with a FRESH unpaired state and
    // nothing ever re-applied — doc paired, room showing "no module
    // connected", vestibule and projection gone. Creating the state here makes
    // the two observer orders converge: apply-then-rebuild keeps this state
    // (buildDoorGroup only seeds when absent, and reopens the leaves of a
    // retained PAIRED state); rebuild-then-apply fills the fresh one and the
    // openDoor below finds a live group.
    const state = this.ensureDoorState(doorId);
    // #62 P2: idempotency must diff the GEOMETRY too — a post-pairing chain
    // edit rewrites the record with the same address, and every client must
    // pick it up (P3 rebuilds the chain + reposes the projection on change).
    const sameGeometry =
      JSON.stringify(state.segments ?? null) ===
        JSON.stringify(geometry?.segments ?? null) &&
      state.farDoor === geometry?.farDoor &&
      // farWall in the diff, or the record gaining a wall (the first
      // walk-through's mirror enriching an auto pairing) would never re-apply
      // and the projection would keep its unrotated pose until a reload.
      state.farWall === geometry?.farWall &&
      state.farLateral === geometry?.farLateral &&
      state.farYawDeg === geometry?.farYawDeg &&
      // ⚓ A re-dock to the same berth is the same geometry with a new stamp.
      state.dockedAt === geometry?.dockedAt;
    if (
      state.pairedSuccessfully &&
      state.connectedRoomAddress === address &&
      sameGeometry
    )
      return;
    state.connectedRoomAddress = address;
    state.segments = geometry?.segments;
    state.farDoor = geometry?.farDoor;
    state.farWall = geometry?.farWall;
    state.farLateral = geometry?.farLateral;
    state.farYawDeg = geometry?.farYawDeg;
    state.transient = geometry?.transient === true; // #67 D2
    state.dockedAt = geometry?.dockedAt; // ⚓ #163
    // ⚓ A staged mating half is spent the moment a pairing lands on the door
    // (ours, published by another of our tabs, or a peer's).
    state.dockMatePaid = false;
    state.pairingPending = false;
    state.pairedSuccessfully = true;
    state.locked = false;
    // 🧭 A remote accept replaces this door's placement hypothesis with the
    // real module — the local INITIATE path clears it in completePairing,
    // but no pane repaint runs on this path, so clear it here.
    if (this.provisionGhost?.userData.doorId === doorId)
      this.removeProvisionGhost();
    this.syncLEDStatus(doorId, state);
    this.drawAdjacentRoomProjection(doorId);
    this.openDoor(doorId);
  }

  /**
   * #64: reverse a pairing removed from the shared `doors` doc (unpair) — tear the
   * projection down, close + re-lock the door. No-op on an already-unpaired door,
   * and (like applyRemotePairing) never fires the publish callback.
   */
  public clearRemotePairing(doorId: string): void {
    const state = this.doorState.get(doorId);
    if (!state || !state.pairedSuccessfully) return;
    state.pairedSuccessfully = false;
    state.pairingPending = false;
    state.connectedRoomAddress = "";
    state.segments = undefined;
    state.farDoor = undefined;
    state.farWall = undefined;
    state.farLateral = undefined;
    state.farYawDeg = undefined;
    state.transient = false;
    state.dockedAt = undefined;
    state.dockMatePaid = false;
    state.locked = true;
    this.removeAdjacentRoomProjection(doorId);
    this.closeDoor(doorId);
    this.syncLEDStatus(doorId, state);
  }

  /** Remove + dispose the adjacent-module gray-box projection (inverse of
   *  drawAdjacentRoomProjection). */
  private removeAdjacentRoomProjection(doorId: string): void {
    const adj = this.adjacentRooms.get(doorId);
    if (!adj) return;
    this.roomsGroup.remove(adj);
    adj.geometry.dispose();
    if (adj.material instanceof THREE.Material) adj.material.dispose();
    this.adjacentRooms.delete(doorId);
  }

  /**
   * Request the door leaves to slide open. onComplete fires exactly once when
   * both leaves reach the open position. A newer opposite-direction request
   * on the same door overwrites the in-flight slide (its onComplete is
   * dropped); a same-direction request chains the callbacks instead.
   */
  public openDoor(doorId: string, onComplete?: () => void): void {
    this.startSlide(doorId, true, onComplete);
  }

  /** Request the door leaves to slide closed. */
  public closeDoor(doorId: string, onComplete?: () => void): void {
    this.startSlide(doorId, false, onComplete);
  }

  /**
   * 🚪 #159: where the hull must stand open — one entry per door whose leaves
   * are not shut, at the pose its FRAME is hung from (poseForDoor, the very
   * call repositionDoorGroups places the group with). Membership is the frames
   * that exist and position is where they are, so an aperture can only ever
   * sit behind its own frame: a removed door heals the wall, a moved one takes
   * its opening with it. `lateral` is the along-wall WORLD coordinate, which is
   * what the hull's faces are measured in.
   */
  public ajarDoorFrames(): Array<{ wall: DoorWall; lateral: number }> {
    const out: Array<{ wall: DoorWall; lateral: number }> = [];
    for (const id of this.doorObjects.keys()) {
      if (!this.isDoorAjar(id)) continue;
      const pose = this.poseForDoor(id);
      out.push({ wall: pose.wall, lateral: pose.tangent === "x" ? pose.x : pose.z });
    }
    return out;
  }

  /**
   * 🚪 #159: are this door's leaves anywhere but fully shut — open, opening or
   * closing? The hull is cut open behind exactly these doors. Behind SHUT
   * leaves the wall stays whole: they meet at a deliberate 4 cm seam, and a cut
   * wall shows through it as a bright hairline down the middle of every closed
   * door.
   */
  private isDoorAjar(doorId: string): boolean {
    // Opening counts from its first frame, so the wall parts WITH the leaves.
    if (this.slideAnims.get(doorId)?.openTarget === DOOR_LEAF_OPEN_OFFSET)
      return true;
    // Otherwise shut or closing, and the leaves say which — update() is the
    // only writer of their position, and snaps it exactly on landing.
    const left = this.doorObjects.get(doorId)?.getObjectByName("leftLeaf");
    return !!left && Math.abs(left.position.x + DOOR_LEAF_SHUT_OFFSET) >= 0.01;
  }

  /**
   * 🚪 #159: `cb` fires whenever ajarDoorFrames may have changed — a slide
   * starting or landing (isDoorAjar), a frame re-posed or removed. This
   * system owns the frames, so it is the one that says so: a caller that moves
   * them (repositionDoorGroups has more than one) cannot forget to. One
   * listener — the world's hull, which re-checks cheaply and only re-cuts on a
   * real change.
   */
  public onDoorApertureChange(cb: () => void): void {
    this.doorApertureListener = cb;
  }

  /**
   * Set the room's ENTRY access mode (public-doors feature) and tint every
   * door's status LED so a visitor reads the room's openness at any threshold:
   * green = PUBLIC (anyone enters), amber = PASS (anyone with the link —
   * today's default), red = KEYED (granted keys only; enforced once keyed
   * identity ships). Driven from the roomInfo observer; distinct from the
   * per-door pairing/lock the docking terminal manages. Idempotent.
   */
  public setAccessMode(mode: "public" | "pass" | "keyed"): void {
    this.accessMode = mode;
    const color =
      mode === "public" ? 0x00e676 : mode === "keyed" ? 0xff1744 : 0xd4a84b;
    for (const group of this.doorObjects.values()) {
      const led = group.getObjectByName("ledStatus") as THREE.Mesh | null;
      const mat = led?.material as THREE.MeshBasicMaterial | undefined;
      if (mat?.color) mat.color.setHex(color);
    }
  }

  /** The current room entry access mode (public-doors feature). */
  public getAccessMode(): "public" | "pass" | "keyed" {
    return this.accessMode;
  }

  private startSlide(
    doorId: string,
    open: boolean,
    onComplete?: () => void,
  ): void {
    const group = this.doorObjects.get(doorId);
    if (!group) return; // no door built — the caller's timeout handles it
    // 🚪 #91: one door size, so the slide targets are shared constants derived
    // from the opening width (they used to be per-size literals here).
    const openTarget = open ? DOOR_LEAF_OPEN_OFFSET : DOOR_LEAF_SHUT_OFFSET;

    // Same-direction overwrite: chain the in-flight onComplete (old first) so
    // an external open (keypad unlock, pairing accept) can't drop a waiting
    // player's door-opened callback. Opposite-direction overwrites still drop
    // the old callback — that completion will never be reached.
    const prev = this.slideAnims.get(doorId);
    if (prev && prev.openTarget === openTarget && prev.onComplete) {
      const prevCb = prev.onComplete;
      const nextCb = onComplete;
      onComplete = nextCb
        ? () => {
            prevCb();
            nextCb();
          }
        : prevCb;
    }

    this.slideAnims.set(doorId, { openTarget, onComplete });
    this.doorApertureListener?.(); // 🚪 #159: an opening door is ajar from now
  }

  /**
   * Advance in-flight leaf slides. Driven from World.update — no detached
   * requestAnimationFrame loops, so completion can be signalled reliably.
   */
  public update(deltaTime: number): void {
    if (this.slideAnims.size === 0) return;
    let landed = false;
    for (const [doorId, anim] of Array.from(this.slideAnims.entries())) {
      const group = this.doorObjects.get(doorId);
      const left = group?.getObjectByName("leftLeaf");
      const right = group?.getObjectByName("rightLeaf");
      if (!left || !right) {
        this.slideAnims.delete(doorId);
        continue;
      }
      const step = this.SLIDE_SPEED * deltaTime;
      left.position.x = moveToward(left.position.x, -anim.openTarget, step);
      right.position.x = moveToward(right.position.x, anim.openTarget, step);
      if (
        Math.abs(left.position.x + anim.openTarget) < 0.01 &&
        Math.abs(right.position.x - anim.openTarget) < 0.01
      ) {
        left.position.x = -anim.openTarget;
        right.position.x = anim.openTarget;
        this.slideAnims.delete(doorId);
        landed = true;
        if (anim.onComplete) anim.onComplete();
      }
    }
    if (landed) this.doorApertureListener?.(); // 🚪 #159: a door that shut is no longer ajar
  }

  /**
   * #51 — screen-lower door transparency in the isometric view. Doors on the
   * camera-facing walls occlude the room interior, so their leaves + frames
   * ease to FACING_FADE_OPACITY while:
   *   - `enabled` (ortho room view live: zoom 2–4, no morph, no device focus),
   *   - the wall's outward normal points toward the camera azimuth (the rig's
   *     current 45° detent — rotation changes WHICH doors are screen-lower),
   *   - and the door is not `activeDoorId` (a walk-through/transit in
   *     progress restores full opacity for the crossing).
   * Called once per frame from World.update, right after update().
   */
  public updateFacingFade(
    deltaTime: number,
    enabled: boolean,
    activeDoorId: DoorId | null,
  ): void {
    // Camera XZ direction for the current detent: the base isometric offset
    // sits on the +X/+Z diagonal (renderer/zoom convention), swung by the
    // rig's snapped yaw — x' = (cosθ+sinθ)/√2, z' = (cosθ−sinθ)/√2.
    const yaw = getCameraYaw();
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const camX = (c + s) * Math.SQRT1_2;
    const camZ = (c - s) * Math.SQRT1_2;

    for (const [doorId, mats] of this.doorFadeMats) {
      const yaw = this.poseForDoor(doorId).outwardYaw;
      const n = { x: Math.sin(yaw), z: Math.cos(yaw) };
      // 45° detents yield dots of 0 / ±0.707 / ±1 — 0.3 splits camera-facing
      // walls (0.707, 1) from side-on and far walls (0, negatives).
      const facing = n.x * camX + n.z * camZ > 0.3;
      const target =
        enabled && facing && activeDoorId !== doorId
          ? DoorDockingPortSystem.FACING_FADE_OPACITY
          : 1.0;

      const current = this.doorFadeOpacity.get(doorId) ?? 1;
      if (current === target) continue;
      let next = current + (target - current) * Math.min(1, 8 * deltaTime);
      if (Math.abs(next - target) < 0.01) next = target;
      this.doorFadeOpacity.set(doorId, next);
      const transparent = next < 0.999;
      for (const mat of mats) {
        mat.opacity = next;
        mat.transparent = transparent;
      }
    }
  }

  /** Read-only access to the PORT pairing a door serves (doorState map is
   *  private). 🚪↔🛰️ #28 S3: pairing/lock/transit are PORT concerns — resolve
   *  the door to its port through portForDoor (identity today; geometric door↔
   *  port alignment in slice 5), so every caller reads port-keyed state via
   *  this one hop and the alignment lands as a single-function change. */
  public getDockingState(doorId: string): DockingState | null {
    return this.doorState.get(portForDoor(doorId)) ?? null;
  }

  /**
   * Render "Gray Box" Projection of the connected room outside the doorway
   */
  private drawAdjacentRoomProjection(doorId: string) {
    // #62 P3: the projection is POSED FROM THE CONNECTION RECORD — the far
    // room's box sits at the folded chain's exit (at its angle) instead of the
    // old hardcoded cardinal 15.2. Legacy pairings (no segments) get the exact
    // pre-#62 pose from the same pure function. Rebuild-on-diff: a chain edit
    // re-runs this via applyRemotePairing's geometry diff, so an existing box
    // drawn with the SAME geometry stays; a different one is disposed+redrawn.
    const state = this.doorState.get(doorId);
    // The key must include everything the POSE depends on — a record gaining
    // its far wall (the first walk-through's mirror enriching an auto pairing)
    // re-applies precisely so this redraw can re-pose it (F6, redo review).
    const farWall = this.farWallFor(state);
    const poseKey = JSON.stringify({
      s: state?.segments ?? null,
      f: state?.farDoor ?? null,
      w: farWall,
      l: state?.farLateral ?? 0,
    });
    const existing = this.adjacentRooms.get(doorId);
    if (existing) {
      if (existing.userData.poseKey === poseKey) return; // unchanged — keep it
      this.removeAdjacentRoomProjection(doorId);
    }

    // Establish scale boundaries equal to active lounge (12x12 plane)
    const roomGeo = new THREE.BoxGeometry(11.8, 4.0, 11.8);
    // Translucent grey wireframe box represents the un-rendered, connected remote room
    const roomMat = new THREE.MeshStandardMaterial({
      color: 0x5a5d64,
      roughness: 0.9,
      transparent: true,
      opacity: 0.45,
      wireframe: false,
    });

    const adjRoom = new THREE.Mesh(roomGeo, roomMat);
    // 🛑📐 The connected module's true half along the far wall when the atlas
    // knows its size — the same offset atlasLayout composes with, so the
    // gray box sits where the exterior will draw the module.
    const farDims = state?.connectedRoomAddress
      ? readAtlas()[roomIdFromSeed(state.connectedRoomAddress)]?.dims
      : undefined;
    const pose = projectionPoseForDoor(
      doorId,
      state?.segments,
      farWall, // resolved once above — the same value the poseKey hashed
      state?.farLateral ?? 0,
      farWall ? halfAlongWall(farDims, farWall) : undefined,
    );
    adjRoom.position.set(pose.x, 2, pose.z);
    adjRoom.rotation.y = pose.rotY;
    adjRoom.userData.poseKey = poseKey;
    // 👻 Owner request: the grey boxes read as huge dark pillars looming over
    // the room's open edges — keep the OBJECT (pairing/transit logic keys off
    // adjacentRooms, and the pose still marks where the far room sits) but
    // never render it.
    adjRoom.visible = false;

    this.roomsGroup.add(adjRoom);
    this.adjacentRooms.set(doorId, adjRoom);

    console.log(
      `📡 Rendered "Gray Box" projection of external capsule outside ${doorId.toUpperCase()} portal`,
    );
  }

  // Bind Listeners
  public onConnectionRequest(cb: (doorId: string, address: string) => void) {
    this.onConnectionRequestCallback = cb;
  }

  public onPairingStatusChanged(cb: (doorId: string, status: string) => void) {
    this.onPairingStatusChangedCallback = cb;
  }

  /**
   * 🧭 The far door's WALL for a pairing: the record's own farWall when a
   * walk-through's mirror (or an informed INITIATE) wrote one, else the far
   * room's gossiped door geometry from the atlas, else null — "unknown", which
   * renders as no rotation. NEVER inferred from the far door's id: an id names
   * a door, it does not place one.
   */
  /**
   * 🚪 Who already has a vestibule on the far room's door this pairing is
   * aimed at — the room id, or null when the atlas knows of none. Three
   * places a claim can live: the far room's own record for that door id; a
   * paired door of the far room within MIN_DOOR_GAP of the aimed wall +
   * lateral (a hypothetical's compass id names no real door, its geometry
   * does); and any OTHER room's record whose far end is that door. "auto"
   * (no id, no wall) cannot be checked here — the arrival enforces it.
   */
  private farDoorTakenBy(
    farRoomId: string,
    farDoor?: string,
    farWall?: DoorWall,
    farLateral?: number,
  ): { roomId: string; doorId?: string } | null {
    const atlas = readAtlas();
    const farDoors = atlas[farRoomId]?.doors ?? {};
    // Geometry decides whenever the wall is known; the id decides only when
    // it is all we have. A farDoor id may be a wall-centre hypothetical's
    // compass guess that the far room hangs on another wall — trusting it
    // first would refuse a free wall because a DIFFERENT door carries the
    // name, or clear a taken one (review, round 2).
    // The answer names the claimant's DOOR as well as its room, so the caller
    // can exempt exactly this door's own existing connection and nothing
    // else — another door of the same room is a second vestibule too
    // (review, round 3).
    const nearOnWall = (wall?: DoorWall, lateral?: number) =>
      wall === farWall && Math.abs((lateral ?? 0) - (farLateral ?? 0)) < MIN_DOOR_GAP;
    if (farWall) {
      for (const d of Object.values(farDoors)) {
        if (d?.targetRoomId && nearOnWall(d.wall, d.lateral))
          return { roomId: d.targetRoomId, doorId: d.farDoor };
      }
    } else if (farDoor && farDoors[farDoor]?.targetRoomId) {
      return { roomId: farDoors[farDoor].targetRoomId, doorId: farDoors[farDoor].farDoor };
    }
    for (const [otherId, entry] of Object.entries(atlas)) {
      if (otherId === farRoomId) continue;
      for (const [odid, od] of Object.entries(entry?.doors ?? {})) {
        if (!od || od.targetRoomId !== farRoomId) continue;
        const taken = farWall
          ? nearOnWall(od.farWall, od.farLateral)
          : !!farDoor && od.farDoor === farDoor;
        if (taken) return { roomId: otherId, doorId: odid };
      }
    }
    return null;
  }

  private farWallFor(state: DockingState | undefined): DoorWall | null {
    if (!state) return null;
    if (state.farWall) return state.farWall;
    if (state.farDoor && state.connectedRoomAddress) {
      const rid = roomIdFromSeed(state.connectedRoomAddress);
      const w = readAtlas()[rid]?.doors[state.farDoor]?.wall;
      if (w) return w;
    }
    return null;
  }

  /** #67 D1: passage check for walk-through/transit (world.ts consults this
   *  before offering the door sequence). */
  public canPass(doorId: string): boolean {
    // 🚪↦ ONE-WAY doors (owner request): this is the DEPARTURE/local-crossing
    // gate (walkthroughs + FP auto-doors) — an IN-only door refuses guest
    // departures (travelers may only come IN through it). OUT-only arrivals
    // are the turnstile's job (world.completeAdapterArrival). Owners pass
    // both ways, always.
    if (this.isRoomOwner()) return true;
    const p = readDoorPolicy(doorId);
    return p.passage === "public" && p.oneWay !== "in";
  }

  /** 🧱 #66 S1: slide each door's 3D group (frame + leaves + keypad ride the
   *  same group) along its wall by the placement delta. Legacy group lateral
   *  is 0 for every door, so position = delta directly. */
  /**
   * 👻🏊 Outdoor open-air mode: ghost every door group down to a faint
   * translucent silhouette (like the entrance glass) so the pool deck reads
   * unobstructed — doors stay raycastable/clickable for transit. Restores the
   * stored opacities when off. Writes userData.baseOpacity so the morph/zoom
   * fade machinery converges to the ghost value instead of fighting it.
   */
  public setGhostDoors(on: boolean): void {
    for (const [, group] of this.doorObjects) {
      group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const mats = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const mat of mats) {
          const m = mat as THREE.Material & {
            opacity: number;
            transparent: boolean;
          };
          if (on) {
            if (m.userData.ghostPrev === undefined) {
              m.userData.ghostPrev = {
                opacity: m.opacity,
                baseOpacity: m.userData.baseOpacity as number | undefined,
                transparent: m.transparent,
              };
            }
            const prev = m.userData.ghostPrev as {
              opacity: number;
              baseOpacity?: number;
            };
            const target = Math.min(0.16, prev.baseOpacity ?? 1);
            m.transparent = true;
            m.userData.baseOpacity = target;
            m.opacity = Math.min(m.opacity, target);
          } else if (m.userData.ghostPrev !== undefined) {
            const prev = m.userData.ghostPrev as {
              opacity: number;
              baseOpacity?: number;
              transparent: boolean;
            };
            delete m.userData.ghostPrev;
            m.transparent = prev.transparent;
            if (prev.baseOpacity === undefined) delete m.userData.baseOpacity;
            else m.userData.baseOpacity = prev.baseOpacity;
            m.opacity = prev.opacity;
          }
        }
      });
    }
  }

  public repositionDoorGroups(
  ): void {
    // 🚪 #18: no delta parameter — every group re-poses from the records.
    for (const [id, group] of this.doorObjects) {
      const pose = this.poseForDoor(id);
      group.position.set(pose.x, 2, pose.z);
      group.rotation.y = pose.frameYaw;
    }
    // 🚪 #159: an open door's aperture is cut where its frame WAS. Every
    // re-pose says so here, whoever asked for it — a door reconcile, a room
    // resize, or applyRoomVisuals re-reading the records under a new legacy
    // layout kind (review of #160).
    this.doorApertureListener?.();
  }

  public refreshDoorInteractivity(): void {
    for (const [id, group] of this.doorObjects) {
      const enabled = findDoor(id)?.enabled === true;
      group.traverse((child) => {
        if (child.userData.doorBodyCandidate !== true) return;
        child.userData.isDoorBody = enabled;
      });
    }
  }

  /** 🛰️ Exterior view: edit one chain segment in place (the click-a-joint
   *  BEND editor). Same rights gate + publish path as the keypad chips — the
   *  record rewrites and every client's geometry diff rebuilds the chain.
   *  Returns false when refused (no rights / no such segment). */
  public editChainSegment(
    doorId: "north" | "south" | "east" | "west",
    index: number,
    patch: {
      bendDeg?: number;
      stretch?: number;
      bays?: number;
      skin?: "ribbed" | "solid";
    },
  ): boolean {
    const state = this.doorState.get(doorId);
    if (!state || !state.segments || !state.segments[index]) return false;
    if (!this.canConstruct(doorId)) return false;
    const seg = { ...state.segments[index], ...patch };
    state.segments = state.segments.map((s, i) => (i === index ? seg : s));
    this.untouchedPrefills.delete(doorId);
    this.renderAssemblyStrip(doorId); // keep an open keypad in sync
    this.publishIfPaired(doorId);
    return true;
  }

  /** #62 P4: wire the auto-accept decider (see field docs). */
  public onAutoAcceptCheck(cb: (address: string) => boolean) {
    this.autoAcceptCheckCallback = cb;
  }

  /** Owner gate: wire the "is the local player this room's owner?" decider. */
  public onOwnerCheck(cb: () => boolean) {
    this.ownerCheckCallback = cb;
  }

  /** Wire the PROVISION NEW MODULE minting callback (see field docs). The
   *  chosen room template id (from the door-panel dropdown) is passed through. */
  public onProvisionModule(
    cb: (
      templateId: string,
      parentDoorId?: string,
      placement?: {
        wall: DoorWall;
        lateral: number;
        doorId?: string;
        port?: boolean;
      },
    ) => Promise<string | null>,
  ) {
    this.provisionModuleCallback = cb;
  }

  /** ⚓ #163: main.ts wires the far-room writer (farDoorWrite.ts). */
  public onFarDockWrite(cb: (req: FarDockRequest) => Promise<FarDockResult>) {
    this.farDockWriter = cb;
  }
}
