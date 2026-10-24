/**
 * 📺 tvScreenLayer — the in-world screen for a picture no texture can carry.
 *
 * A <video> goes on the set's screen as a VideoTexture (furniture.ts, the
 * handle's showVideo). An embed's iframe (YouTube, archive.org) cannot be
 * sampled into a texture, so it is laid over the set's screen plane in the
 * DOM instead: one CSS3DRenderer layer over the world's canvas, holding one
 * CSS3DObject that copies the plane's world matrix every frame, so the
 * picture sits on the set as the camera swings and zooms, and is shown only
 * while the set's screen is (World hides the furniture outside the room
 * view) and the theatre says the programme is playing or paused — hidden by
 * CSS visibility, never taken out of the document, so an iframe laid during
 * a countdown loads and is ready at T0. The layer
 * takes no pointer events (the world under it keeps its clicks; the remote
 * and the theatre's bar are the controls), and, being over the canvas, it is
 * not hidden by whatever stands between the camera and the set.
 */

import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js';

/** The host's size in CSS pixels; the object is scaled from this to metres. */
const HOST_W = 960;
const HOST_H = 540;

interface Layer {
  renderer: CSS3DRenderer;
  scene: THREE.Scene;
  object: CSS3DObject;
  plane: THREE.Object3D;
  planeW: number;
  planeH: number;
  frame: number;
  onResize: () => void;
}

let layer: Layer | null = null;
/** The theatre's word: the programme is playing or paused (a countdown and
 *  a home screen are the set's own card). */
let shown = false;

/** Whether the laid picture may show (tvTheatre, every tick). */
export function setScreenHostShown(on: boolean): void {
  shown = on;
}

/** The plane is drawn: it and every ancestor visible. */
function drawn(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

function camera(): THREE.Camera | null {
  return (window as unknown as { gameRenderer?: { camera?: THREE.Camera } }).gameRenderer?.camera ?? null;
}

/** Lay `host` (which the adapter fills with its iframe) on `plane`, a
 *  `planeW` × `planeH` metre screen facing +z. One picture at a time: a
 *  second call moves the layer to the new host. `interactive`: the picture
 *  takes the pointer (archive.org's embed, whose volume and controls are
 *  only inside its frame); otherwise clicks go through to the world. */
export function attachScreenHost(host: HTMLElement, plane: THREE.Object3D, planeW: number, planeH: number, interactive = false): void {
  detachScreenHost();
  host.style.width = `${HOST_W}px`;
  host.style.height = `${HOST_H}px`;
  host.style.background = '#000';
  // Seen from behind the set, the screen shows nothing (a WebGL plane is
  // one-sided): the DOM picture would show through the cabinet, mirrored.
  host.style.backfaceVisibility = 'hidden';
  const renderer = new CSS3DRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  const el = renderer.domElement;
  el.id = 'tv-screen-layer';
  el.style.position = 'fixed';
  el.style.inset = '0';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '1';
  document.body.appendChild(el);
  const scene = new THREE.Scene();
  const object = new CSS3DObject(host);
  // CSS3DObject sets its element's pointer events back to `auto`: the
  // picture takes none, or it would catch the world's clicks and offer the
  // embed's own controls — unless those controls are the only ones.
  host.style.pointerEvents = interactive ? 'auto' : 'none';
  object.matrixAutoUpdate = false;
  scene.add(object);
  const onResize = () => renderer.setSize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);
  const l: Layer = { renderer, scene, object, plane, planeW, planeH, frame: 0, onResize };
  layer = l;
  const scale = new THREE.Matrix4();
  const step = () => {
    if (layer !== l) return;
    const cam = camera();
    // Not the object's `visible`: CSS3DRenderer leaves an invisible object
    // out of the document, and an iframe out of it does not load — YouTube's
    // laid during a countdown would time out before T0.
    const vis = shown && drawn(l.plane) ? '' : 'hidden';
    if (l.object.element.style.visibility !== vis) l.object.element.style.visibility = vis;
    if (cam) {
      // The host is fitted inside the plane (16:9 into whatever the set is).
      const s = Math.min(l.planeW / HOST_W, l.planeH / HOST_H);
      l.plane.updateWorldMatrix(true, false);
      l.object.matrix.multiplyMatrices(l.plane.matrixWorld, scale.makeScale(s, s, 1));
      l.object.matrixWorldNeedsUpdate = true;
      l.renderer.render(l.scene, cam);
    }
    l.frame = requestAnimationFrame(step);
  };
  step();
}

/** Take the laid picture off the world (the host stays the caller's). */
export function detachScreenHost(): void {
  const l = layer;
  if (!l) return;
  layer = null;
  cancelAnimationFrame(l.frame);
  window.removeEventListener('resize', l.onResize);
  l.scene.remove(l.object);
  l.object.element.remove();
  l.renderer.domElement.remove();
}
