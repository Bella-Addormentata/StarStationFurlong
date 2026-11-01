/**
 * 🖍 The chalkboard's 3D piece (Dorkmo 2026-11-01): a slate board in an oak
 * frame, hung on the wall like the corkboard and the smart TV (flush wall
 * mount, never an obstacle), with a tray along its foot holding an
 * oversized stick of chalk and a big felt eraser.
 *
 * The face is a CanvasTexture of the board's picture (chalkDoc.ts), redrawn
 * each frame only where it changed. The handle (`userData.chalkboard`, filed
 * by furnitureHandles.ts) is what the focused board's session
 * (chalkSession.ts) aims at: which part a ray hits, where on the slate, and
 * the tool in the player's hand, drawn where the pointer is. What a player
 * holds is theirs alone: nobody else's tray changes.
 *
 * Local frame (rot 0): the wall's face is z = 0, the board faces +z, x runs
 * along the wall.
 */

import * as THREE from 'three';
import type { BuildCtx } from './furniture';
import { chalkBoardFrame } from './chalkDoc';
import {
  CHALK_GRID_H,
  CHALK_GRID_W,
  CHALK_MAX_X,
  CHALK_MAX_Y,
  CHALK_SUB,
  ERASER_HH,
  ERASER_HW,
  paintChalkPixels,
  type ChalkPoint,
  type ChalkSurface,
  type ChalkTool,
} from './chalkRender';

// ── Size ─────────────────────────────────────────────────────────────────────

/** The writing area (the slate inside the frame), metres. */
export const CHALK_FACE_W = 1.68;
export const CHALK_FACE_H = (CHALK_FACE_W * CHALK_GRID_H) / CHALK_GRID_W;
const CELL = CHALK_FACE_W / CHALK_GRID_W;
const FRAME = 0.05;
/** The whole board, frame included. */
export const CHALKBOARD_W = CHALK_FACE_W + 2 * FRAME;
const BOARD_H = CHALK_FACE_H + 2 * FRAME;
/** The face's centre height: a standing hand reaches its top and its tray. */
export const CHALKBOARD_Y = 1.45;
const DEPTH = 0.035;
const FACE_Z = 0.022;
/** The tray's top surface, just under the frame's bottom rail. */
const TRAY_TOP = CHALKBOARD_Y - BOARD_H / 2 - 0.004;
const TRAY_D = 0.1;

/** The chalk stick: oversized, as asked. */
const CHALK_STICK_R = 0.011;
const CHALK_STICK_L = 0.13;
/** The eraser's felt matches its wipe (chalkRender ERASER_HW × ERASER_HH). */
const ERASER_W = 2 * ERASER_HW * CELL;
const ERASER_H = 2 * ERASER_HH * CELL;
const ERASER_FELT = 0.011;
const ERASER_BACK = 0.024;
/** Where each tool lies on the tray. */
const CHALK_REST = new THREE.Vector3(0.45, TRAY_TOP + CHALK_STICK_R, 0.055);
const ERASER_REST = new THREE.Vector3(-0.45, TRAY_TOP, 0.055);
/** The held chalk's lean: out of the board, down and to the right, as a
 *  right hand holds it. */
const CHALK_LEAN = new THREE.Vector3(0.28, -0.5, 0.82).normalize();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** The focus camera's pose: a pace back, framing the slate and its tray. */
export const CHALKBOARD_EYE = { x: 0, y: 1.38, z: 1.85 };
export const CHALKBOARD_ANCHOR = { x: 0, y: 1.32, z: 0.05 };

// ── The handle ───────────────────────────────────────────────────────────────

/** What a ray hits on the board. On the slate it carries the point, in
 *  half cells (chalkRender's stored units). */
export type ChalkPick =
  | { what: 'chalk' | 'eraser' | 'tray' | 'frame' }
  | { what: 'board'; point: ChalkPoint };

/** Where a ray meets the board's plane (the slate extended), in half cells. */
export interface ChalkPlanePoint {
  point: ChalkPoint;
  /** On the slate itself. */
  inside: boolean;
}

export interface ChalkboardHandle {
  readonly itemId: string;
  /** The nearest part of the board under the ray, or null when it misses. */
  pick(ray: THREE.Raycaster): ChalkPick | null;
  /** Where the ray meets the slate's plane, or null when it can't. */
  planePoint(ray: THREE.Raycaster): ChalkPlanePoint | null;
  /** The tool in the player's hand (null: both on the tray). */
  setHeld(tool: ChalkTool | null): void;
  /** Where the held tool is, on the slate's plane (null: out of view), and
   *  whether it is pressed to the board. */
  setHand(at: ChalkPlanePoint | null, pressed: boolean): void;
  /** Every frame: the board's timers, and the face where it changed. */
  update(dt: number): void;
}

/** Half cells on the slate → the board's local frame (the face's plane). */
function localOf(p: ChalkPoint, out: THREE.Vector3): THREE.Vector3 {
  const u = (p.x + 0.5) / (CHALK_GRID_W * CHALK_SUB);
  const v = (p.y + 0.5) / (CHALK_GRID_H * CHALK_SUB);
  return out.set(-CHALK_FACE_W / 2 + u * CHALK_FACE_W, CHALKBOARD_Y + CHALK_FACE_H / 2 - v * CHALK_FACE_H, FACE_Z);
}

/** The board's local frame → half cells (unclamped). */
function pointOf(local: THREE.Vector3): ChalkPoint {
  const u = (local.x + CHALK_FACE_W / 2) / CHALK_FACE_W;
  const v = (CHALKBOARD_Y + CHALK_FACE_H / 2 - local.y) / CHALK_FACE_H;
  return { x: Math.floor(u * CHALK_GRID_W * CHALK_SUB), y: Math.floor(v * CHALK_GRID_H * CHALK_SUB) };
}

// ── The build ────────────────────────────────────────────────────────────────

export function buildChalkboard(ctx: BuildCtx): void {
  const { m, place } = ctx;
  const oak = m(0x9a6b3f, 0.62, 0.04);
  const backing = m(0x2a1d12, 0.9, 0);
  place(new THREE.BoxGeometry(CHALKBOARD_W - 0.02, BOARD_H - 0.02, 0.02), backing, 0, CHALKBOARD_Y, 0.01);
  const rails: THREE.Mesh[] = [
    place(new THREE.BoxGeometry(CHALKBOARD_W, FRAME, DEPTH), oak, 0, CHALKBOARD_Y + BOARD_H / 2 - FRAME / 2, DEPTH / 2),
    place(new THREE.BoxGeometry(CHALKBOARD_W, FRAME, DEPTH), oak, 0, CHALKBOARD_Y - BOARD_H / 2 + FRAME / 2, DEPTH / 2),
    place(new THREE.BoxGeometry(FRAME, CHALK_FACE_H, DEPTH), oak, -CHALKBOARD_W / 2 + FRAME / 2, CHALKBOARD_Y, DEPTH / 2),
    place(new THREE.BoxGeometry(FRAME, CHALK_FACE_H, DEPTH), oak, CHALKBOARD_W / 2 - FRAME / 2, CHALKBOARD_Y, DEPTH / 2),
  ];
  for (const r of rails) r.userData.chalkPart = 'frame';

  // The tray: a shelf the width of the board, a lip along its front edge.
  const trayMat = m(0x8a5d35, 0.66, 0.04);
  const shelf = place(new THREE.BoxGeometry(CHALKBOARD_W, 0.018, TRAY_D), trayMat, 0, TRAY_TOP - 0.009, TRAY_D / 2);
  const lip = place(new THREE.BoxGeometry(CHALKBOARD_W, 0.03, 0.012), trayMat, 0, TRAY_TOP + 0.006, TRAY_D - 0.006);
  shelf.userData.chalkPart = 'tray';
  lip.userData.chalkPart = 'tray';
  // A haze of old dust along the tray, as every chalk tray has.
  const dust = place(new THREE.BoxGeometry(CHALKBOARD_W - 0.08, 0.001, TRAY_D - 0.03), m(0xc9cbc4, 0.95, 0), 0, TRAY_TOP + 0.0006, TRAY_D / 2 - 0.004);
  dust.userData.chalkPart = 'tray';

  // The slate: the board's picture, painted from the room's marks.
  const cv = document.createElement('canvas');
  cv.width = CHALK_GRID_W;
  cv.height = CHALK_GRID_H;
  const c2d = cv.getContext('2d')!;
  const pixels = c2d.createImageData(CHALK_GRID_W, CHALK_GRID_H);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Unlit like the corkboard's face, a shade under white so solid chalk
  // doesn't glare in a dim room.
  const faceMat = new THREE.MeshBasicMaterial({ map: tex, color: 0xe2e2e2, transparent: true, opacity: 0 });
  const face = place(new THREE.PlaneGeometry(CHALK_FACE_W, CHALK_FACE_H), faceMat, 0, CHALKBOARD_Y, FACE_Z);
  face.userData.chalkPart = 'board';

  // The tools at rest, each with a generous invisible grab box.
  const chalkMat = m(0xf3f1e8, 0.95, 0);
  const feltMat = m(0x3b3e46, 0.98, 0);
  const backMat = m(0x7b4f2c, 0.6, 0.04);
  const restChalk = new THREE.Group();
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(CHALK_STICK_R, CHALK_STICK_R, CHALK_STICK_L, 14), chalkMat);
  stick.rotation.z = Math.PI / 2;
  restChalk.add(stick);
  restChalk.position.copy(CHALK_REST);
  ctx.attach(restChalk);
  const restEraser = new THREE.Group();
  const restFelt = new THREE.Mesh(new THREE.BoxGeometry(ERASER_W, ERASER_FELT, ERASER_H), feltMat);
  restFelt.position.y = ERASER_FELT / 2;
  const restBack = new THREE.Mesh(new THREE.BoxGeometry(ERASER_W, ERASER_BACK, ERASER_H), backMat);
  restBack.position.y = ERASER_FELT + ERASER_BACK / 2;
  restEraser.add(restFelt, restBack);
  restEraser.position.copy(ERASER_REST);
  ctx.attach(restEraser);
  const grabMat = new THREE.MeshBasicMaterial({ visible: false });
  const grabChalk = place(new THREE.BoxGeometry(0.22, 0.08, TRAY_D), grabMat, CHALK_REST.x, TRAY_TOP + 0.03, TRAY_D / 2);
  const grabEraser = place(new THREE.BoxGeometry(0.22, 0.09, TRAY_D), grabMat, ERASER_REST.x, TRAY_TOP + 0.035, TRAY_D / 2);
  grabChalk.userData.chalkPart = 'chalk';
  grabEraser.userData.chalkPart = 'eraser';

  // The tools in hand: drawn where the pointer is, only while held. Each is a
  // group, and only the group is ever hidden: World turns every furniture
  // MESH back on when the camera returns to the room levels.
  const heldStick = new THREE.Mesh(new THREE.CylinderGeometry(CHALK_STICK_R, CHALK_STICK_R * 0.82, CHALK_STICK_L, 14), chalkMat);
  const heldChalk = new THREE.Group();
  heldChalk.add(heldStick);
  heldChalk.quaternion.setFromUnitVectors(Y_AXIS, CHALK_LEAN);
  heldChalk.visible = false;
  ctx.attach(heldChalk);
  const heldEraser = new THREE.Group();
  const heldFelt = new THREE.Mesh(new THREE.BoxGeometry(ERASER_W, ERASER_H, ERASER_FELT), feltMat);
  heldFelt.position.z = ERASER_FELT / 2;
  const heldBack = new THREE.Mesh(new THREE.BoxGeometry(ERASER_W, ERASER_H, ERASER_BACK), backMat);
  heldBack.position.z = ERASER_FELT + ERASER_BACK / 2;
  heldEraser.add(heldFelt, heldBack);
  heldEraser.visible = false;
  ctx.attach(heldEraser);
  // The held tools are never what a click lands on, and wait out of sight in
  // front of the slate, never behind the wall.
  for (const mesh of [heldStick, heldFelt, heldBack]) mesh.userData.skipDeviceHit = true;
  heldChalk.position.set(0, CHALKBOARD_Y, FACE_Z).addScaledVector(CHALK_LEAN, CHALK_STICK_L / 2);
  heldEraser.position.set(0, CHALKBOARD_Y, FACE_Z + 0.01);

  const pickable = [grabChalk, grabEraser, shelf, lip, dust, face, ...rails];
  const plane = new THREE.Plane();
  const normal = new THREE.Vector3();
  const onFace = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const local = new THREE.Vector3();
  let held: ChalkTool | null = null;
  let lastSurface: ChalkSurface | null = null;

  const handle: ChalkboardHandle = {
    itemId: ctx.itemId,

    pick(ray) {
      const hits = ray.intersectObjects(pickable, false);
      for (const h of hits) {
        const part = h.object.userData.chalkPart as string | undefined;
        if (!part) continue;
        // A tool in hand is not on the tray: its grab box is just tray.
        if ((part === 'chalk' && held === 'chalk') || (part === 'eraser' && held === 'eraser')) return { what: 'tray' };
        if (part === 'board') {
          const p = handle.planePoint(ray);
          return p ? { what: 'board', point: p.point } : { what: 'frame' };
        }
        return { what: part as 'chalk' | 'eraser' | 'tray' | 'frame' };
      }
      return null;
    },

    planePoint(ray) {
      const parent = face.parent;
      if (!parent) return null;
      face.updateWorldMatrix(true, false);
      normal.set(0, 0, 1).transformDirection(face.matrixWorld);
      onFace.setFromMatrixPosition(face.matrixWorld);
      plane.setFromNormalAndCoplanarPoint(normal, onFace);
      if (!ray.ray.intersectPlane(plane, hit)) return null;
      local.copy(hit);
      parent.worldToLocal(local);
      const point = pointOf(local);
      const inside = point.x >= 0 && point.y >= 0 && point.x <= CHALK_MAX_X && point.y <= CHALK_MAX_Y;
      return { point, inside };
    },

    setHeld(tool) {
      held = tool;
      restChalk.visible = tool !== 'chalk';
      restEraser.visible = tool !== 'eraser';
      if (!tool) {
        heldChalk.visible = false;
        heldEraser.visible = false;
      }
    },

    setHand(at, pressed) {
      heldChalk.visible = held === 'chalk' && at !== null;
      heldEraser.visible = held === 'eraser' && at !== null;
      if (!at) return;
      localOf(at.point, local);
      if (held === 'chalk') {
        // The tip on the slate (a hair off it until pressed).
        const lift = pressed ? 0.001 : 0.008;
        heldChalk.position.copy(local).addScaledVector(CHALK_LEAN, CHALK_STICK_L / 2 + lift);
      } else if (held === 'eraser') {
        heldEraser.position.set(local.x, local.y, FACE_Z + (pressed ? 0.0005 : 0.01));
      }
    },

    update() {
      const surface = chalkBoardFrame(ctx.itemId);
      if (surface !== lastSurface) {
        lastSurface = surface;
        surface.markAll();
      }
      const r = surface.takeDirty();
      if (!r) return;
      paintChalkPixels(surface, pixels.data, r);
      c2d.putImageData(pixels, 0, 0, r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1);
      tex.needsUpdate = true;
    },
  };
  face.userData.chalkboard = handle; // filed by registerFurnitureHandles (furnitureHandles.ts)
}
