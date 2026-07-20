/**
 * NPC - Beautiful anime princess. Canvas 160×240, rendered at 4× then
 * downsampled by Three.js giving natural anti-aliasing.
 */
import * as THREE from 'three';
import { InputManager } from './input';
import { roomHalfExtents } from './floorPlanDoc';

const W = 160, H = 240;

// ── Static obstacle AABB list (XZ plane) ─────────────────────────────────────
// Each box is inflated by NPC_R so we can treat the NPC as a point.
const NPC_R = 0.38;
interface Box { x0: number; z0: number; x1: number; z1: number; }
const OBSTACLES: Box[] = [
  // Fireplace / bookcase wall (full width, front face z≈-5.55, depth 0.46)
  { x0: -5.00, z0: -5.95, x1:  5.00, z1: -5.08 },
  // Back 3-seater sofa (seat centre 0, -1.5 — size 2.4 × 0.96)
  { x0: -1.50, z0: -2.12, x1:  1.50, z1: -0.88 },
  // Front 3-seater sofa (seat centre 0, +3.2)
  { x0: -1.50, z0:  2.58, x1:  1.50, z1:  3.82 },
  // Left-wall armchairs × 5 merged (x=-4.3, z=-3.8/−2.4/−1.0/0.4/1.8)
  { x0: -4.82, z0: -4.32, x1: -3.78, z1:  2.32 },
  // Right-wall armchairs × 5 merged (x=+4.3)
  { x0:  3.78, z0: -4.32, x1:  4.82, z1:  2.32 },
  // Coffee table — back zone (centre 0, -3.3  size 1.6 × 0.9)
  { x0: -0.94, z0: -3.82, x1:  0.94, z1: -2.78 },
  // Coffee table — front zone (centre 0, +1.5  size 1.6 × 0.9)
  { x0: -0.94, z0:  1.02, x1:  0.94, z1:  1.98 },
  // Bar cabinet + stools (x≈5.24, z≈3.10, body 0.58 × 2.80 + stools)
  { x0:  4.48, z0:  1.48, x1:  5.92, z1:  4.72 },
  // Lamp table back-L (centre -4.3, -4.7)
  { x0: -4.62, z0: -5.02, x1: -3.98, z1: -4.38 },
  // Lamp table back-R (centre +4.3, -4.7)
  { x0:  3.98, z0: -5.02, x1:  4.62, z1: -4.38 },
  // Lamp table front-L (centre -3.8, +3.2)
  { x0: -4.12, z0:  2.88, x1: -3.48, z1:  3.52 },
  // Lamp table front-R (centre +3.8, +3.2)
  { x0:  3.48, z0:  2.88, x1:  4.12, z1:  3.52 },
  // Cherry blossom tree front-L (centre -5.0, +4.5)
  { x0: -5.48, z0:  4.08, x1: -4.52, z1:  4.92 },
  // Cherry blossom tree front-L2 (centre -5.0, +3.0)
  { x0: -5.48, z0:  2.58, x1: -4.52, z1:  3.42 },
  // Cherry blossom tree back-L (centre -4.9, -5.0)
  { x0: -5.38, z0: -5.48, x1: -4.42, z1: -4.52 },
  // Cherry blossom tree back-R (centre +4.9, -5.0)
  { x0:  4.42, z0: -5.48, x1:  5.38, z1: -4.52 },
];

/**
 * Inflate each obstacle by NPC_R, then check if point (x,z) is inside.
 * Returns the push-out position (minimum-penetration axis).
 */
function resolveObstacles(x: number, z: number): { x: number; z: number } {
  let rx = x, rz = z;
  for (const b of OBSTACLES) {
    const ex0 = b.x0 - NPC_R, ex1 = b.x1 + NPC_R;
    const ez0 = b.z0 - NPC_R, ez1 = b.z1 + NPC_R;
    if (rx > ex0 && rx < ex1 && rz > ez0 && rz < ez1) {
      const dL = rx - ex0, dR = ex1 - rx, dT = rz - ez0, dB = ez1 - rz;
      const m = Math.min(dL, dR, dT, dB);
      if      (m === dL) rx = ex0;
      else if (m === dR) rx = ex1;
      else if (m === dT) rz = ez0;
      else               rz = ez1;
    }
  }
  return { x: rx, z: rz };
}

// ── Sit zones: rectangles where NPC can sit (near sofa/chair edges) ─────────
// Each zone has an approach box + a canonical sit position + facing direction
interface SitZone { x0: number; z0: number; x1: number; z1: number;
                    sx: number; sz: number; face: 'front'|'back'|'side'; faceDir: number; }
const SIT_ZONES: SitZone[] = [
  // Back sofa: NPC blocked at z≈-0.50 (inflated obstacle south edge) — approach from south
  { x0: -1.4, z0: -0.8, x1:  1.4, z1:  0.1, sx:  0.0, sz: -1.50, face: 'back',  faceDir:  1 },
  // Front sofa: coffee table blocks center; approach from left side (x < -1.32)
  { x0: -1.8, z0:  1.5, x1: -1.1, z1:  2.2, sx:  0.0, sz:  2.65, face: 'back',  faceDir:  1 },
  // Front sofa: approach from right side (x > 1.32)
  { x0:  1.1, z0:  1.5, x1:  1.8, z1:  2.2, sx:  0.0, sz:  2.65, face: 'back',  faceDir:  1 },
  // Left wall chairs: NPC blocked at x≈-3.40 (inflated obstacle right edge)
  { x0: -3.6, z0: -4.2, x1: -3.2, z1: -3.4, sx: -4.3, sz: -3.8, face: 'side',  faceDir:  1 },
  { x0: -3.6, z0: -2.8, x1: -3.2, z1: -2.0, sx: -4.3, sz: -2.4, face: 'side',  faceDir:  1 },
  { x0: -3.6, z0: -1.4, x1: -3.2, z1: -0.6, sx: -4.3, sz: -1.0, face: 'side',  faceDir:  1 },
  { x0: -3.6, z0:  0.0, x1: -3.2, z1:  0.8, sx: -4.3, sz:  0.4, face: 'side',  faceDir:  1 },
  { x0: -3.6, z0:  1.4, x1: -3.2, z1:  2.2, sx: -4.3, sz:  1.8, face: 'side',  faceDir:  1 },
  // Right wall chairs: NPC blocked at x≈3.40 (inflated obstacle left edge)
  { x0:  3.2, z0: -4.2, x1:  3.6, z1: -3.4, sx:  4.3, sz: -3.8, face: 'side',  faceDir: -1 },
  { x0:  3.2, z0: -2.8, x1:  3.6, z1: -2.0, sx:  4.3, sz: -2.4, face: 'side',  faceDir: -1 },
  { x0:  3.2, z0: -1.4, x1:  3.6, z1: -0.6, sx:  4.3, sz: -1.0, face: 'side',  faceDir: -1 },
  { x0:  3.2, z0:  0.0, x1:  3.6, z1:  0.8, sx:  4.3, sz:  0.4, face: 'side',  faceDir: -1 },
  { x0:  3.2, z0:  1.4, x1:  3.6, z1:  2.2, sx:  4.3, sz:  1.8, face: 'side',  faceDir: -1 },
];

export class NPC {
  public mesh: THREE.Sprite;
  private tex: THREE.CanvasTexture;
  private cv: HTMLCanvasElement;
  private cx: CanvasRenderingContext2D;
  private elapsed = 0;
  private facing = 1;
  private view: 'front'|'back'|'side' = 'front';
  private readonly SPEED = 2.2;

  /** Movement clamp: 0.8 m inside each wall, per axis (walls at ±half).
   *  🧱 #66 R1 — default 2×2 room ⇒ ±5.2, the legacy BOUND scalar. */
  private roomBounds(): { boundX: number; boundZ: number } {
    const { halfX, halfZ } = roomHalfExtents();
    return { boundX: halfX - 0.8, boundZ: halfZ - 0.8 };
  }

  // Sit state
  private sitting = false;
  private sitBlend = 0;           // 0 = standing, 1 = fully seated
  private idleTimer = 0;          // seconds idle while inside a sit zone
  private currentZone: SitZone | null = null; // locked zone while seated
  private readonly SIT_DELAY = 1.2;
  private readonly SIT_SPEED = 2.5;

  constructor(scene: THREE.Scene) {
    this.cv = document.createElement('canvas');
    this.cv.width = W; this.cv.height = H;
    this.cx = this.cv.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.cv);
    this.mesh = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.tex, transparent: true, alphaTest: 0.04 })
    );
    this.mesh.scale.set(1.35, 2.03, 1);
    const sx = (Math.random()-.5)*6, sz = (Math.random()-.5)*6;
    this.mesh.position.set(sx, 1.0, sz);
    scene.add(this.mesh);
    this.redraw(0, true);
  }

  update(dt: number, inputManager: InputManager) {
    this.elapsed += dt;
    const pos = this.mesh.position;
    const dir = inputManager.getMoveDirection();
    const moving = dir.x !== 0 || dir.z !== 0;

    // When already seated keep the locked zone; otherwise scan approach boxes
    const zone = (this.sitting && this.currentZone)
      ? this.currentZone
      : (SIT_ZONES.find(z =>
          pos.x >= z.x0 && pos.x <= z.x1 && pos.z >= z.z0 && pos.z <= z.z1
        ) ?? null);

    if (moving) {
      // Any input: stand up immediately, reset timer
      this.sitting = false;
      this.currentZone = null;
      this.idleTimer = 0;
      this.sitBlend = Math.max(0, this.sitBlend - dt * this.SIT_SPEED * 2);

      const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
      const nx = dir.x / len, nz = dir.z / len;
      if (Math.abs(nx) > 0.06) this.facing = nx > 0 ? 1 : -1;
      const adx = Math.abs(nx), adz = Math.abs(nz);
      this.view = adz > adx * 1.2 ? (nz < 0 ? 'back' : 'front') : 'side';

      const { boundX, boundZ } = this.roomBounds();
      const candX = Math.max(-boundX, Math.min(boundX, pos.x + nx * this.SPEED * dt));
      const r1 = resolveObstacles(candX, pos.z);
      const candZ = Math.max(-boundZ, Math.min(boundZ, pos.z + nz * this.SPEED * dt));
      const r2 = resolveObstacles(r1.x, candZ);
      pos.x = r2.x; pos.z = r2.z;
      pos.y = 1.0 + Math.abs(Math.sin(this.elapsed * 6.5)) * (this.view === 'side' ? 0.058 : 0.038);
      this.redraw(Math.floor(this.elapsed * 7) % 4, false);

    } else if (zone) {
      // Idle inside a sit zone: count down then sit
      this.idleTimer += dt;

      if (!this.sitting && this.idleTimer >= this.SIT_DELAY) {
        this.sitting = true;
        this.currentZone = zone;   // lock zone so snap doesn't break detection
        // Snap to seat position & facing
        pos.x = zone.sx; pos.z = zone.sz;
        this.view = zone.face;
        this.facing = zone.faceDir;
      }

      if (this.sitting) {
        this.sitBlend = Math.min(1, this.sitBlend + dt * this.SIT_SPEED);
      }

      // Seated height: lower the sprite so feet touch the seat
      const seatY = 0.62;
      pos.y = 1.0 + (seatY - 1.0) * this.sitBlend + Math.sin(this.elapsed * 1.4) * 0.008;
      this.redraw(0, !this.sitting);

    } else {
      // Idle outside sit zones: normal breathing
      this.sitting = false;
      this.idleTimer = 0;
      this.sitBlend = Math.max(0, this.sitBlend - dt * this.SIT_SPEED);
      pos.y = 1.0 + Math.sin(this.elapsed * 1.8) * 0.018;
      this.redraw(0, true);
    }
  }

  private redraw(fr: number, idle: boolean) {
    this.cx.clearRect(0,0,W,H);
    if (this.sitBlend > 0.5) {
      this.drawSit();
    } else if (this.view==='back') {
      this.drawBack(fr,idle);
    } else if (this.view==='side') {
      this.drawSide(fr,idle);
    } else {
      this.drawFront(fr,idle);
    }
    this.tex.needsUpdate = true;
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private f(c:string){this.cx.fillStyle=c;}
  private s(c:string,w=1.2){this.cx.strokeStyle=c;this.cx.lineWidth=w;}
  private elS(x:number,y:number,rx:number,ry:number,rot=0){
    this.cx.beginPath();this.cx.ellipse(x,y,rx,ry,rot,0,Math.PI*2);this.cx.stroke();
  }
  private bez(_x1:number,_y1:number,cx1:number,cy1:number,cx2:number,cy2:number,x2:number,y2:number){
    this.cx.bezierCurveTo(cx1,cy1,cx2,cy2,x2,y2);
  }

  // ── shared gown ───────────────────────────────────────────────────────────
  private gown(bob:number, sw:number) {
    const c=this.cx;
    // main dress shape
    const gd = c.createLinearGradient(80,112+bob,80,238);
    gd.addColorStop(0,'#C8960E'); gd.addColorStop(.08,'#E4B028');
    gd.addColorStop(.22,'#FFF4DC'); gd.addColorStop(.55,'#FDFFF8');
    gd.addColorStop(1,'#D4F0E4');
    c.fillStyle=gd;
    c.beginPath(); c.moveTo(52,112+bob);
    this.bez(52,112+bob, 38+sw,138, 12+sw,178, 8,238);
    c.lineTo(152,238);
    this.bez(152,238, 148-sw,178, 122-sw,138, 108,112+bob);
    c.closePath(); c.fill();
    // left sheen
    const sl=c.createLinearGradient(24,118+bob,72,162);
    sl.addColorStop(0,'rgba(255,255,220,.52)'); sl.addColorStop(1,'rgba(255,255,220,0)');
    c.fillStyle=sl;
    c.beginPath(); c.moveTo(52,112+bob);
    this.bez(52,112+bob,40+sw,138,22+sw,170,18,218);
    c.lineTo(62,218);
    this.bez(62,218,58,176,54,148,60,116+bob);
    c.closePath(); c.fill();
    // embroidery trim lines
    this.s('#A86808',.9);
    c.beginPath(); c.moveTo(68,114+bob);
    this.bez(68,114+bob,64,152,60,184,58,228); c.stroke();
    c.beginPath(); c.moveTo(92,114+bob);
    this.bez(92,114+bob,96,152,100,184,102,228); c.stroke();
    // decorative swirl left
    this.s('rgba(200,140,20,.55)',.8);
    c.beginPath(); c.moveTo(40,148+bob*.2);
    c.bezierCurveTo(28,154,28,168,40,170); c.bezierCurveTo(52,172,52,158,40,160); c.stroke();
    c.beginPath(); c.moveTo(120,148+bob*.2);
    c.bezierCurveTo(132,154,132,168,120,170); c.bezierCurveTo(108,172,108,158,120,160); c.stroke();
  }

  // ── bodice ────────────────────────────────────────────────────────────────
  private bodice(bob:number) {
    const c=this.cx;
    const gb=c.createLinearGradient(50,70+bob,110,114+bob);
    gb.addColorStop(0,'#E8B230'); gb.addColorStop(.4,'#F8CE50'); gb.addColorStop(1,'#C89010');
    c.fillStyle=gb;
    c.beginPath();
    c.moveTo(50,72+bob); c.lineTo(110,72+bob);
    c.lineTo(114,114+bob); c.lineTo(46,114+bob); c.closePath(); c.fill();
    // collar V
    this.f('rgba(255,244,210,.72)');
    c.beginPath(); c.moveTo(66,72+bob); c.lineTo(94,72+bob); c.lineTo(80,90+bob); c.closePath(); c.fill();
    // center line
    this.s('#A87008',1.1); c.beginPath(); c.moveTo(80,72+bob); c.lineTo(80,114+bob); c.stroke();
    // teal gem
    const gg=c.createRadialGradient(80,88+bob,1,80,88+bob,11);
    gg.addColorStop(0,'#A0FFF0'); gg.addColorStop(.45,'#20C8A4'); gg.addColorStop(1,'#006858');
    c.fillStyle=gg;
    c.beginPath();
    c.moveTo(80,78+bob); c.lineTo(90,88+bob); c.lineTo(80,98+bob); c.lineTo(70,88+bob);
    c.closePath(); c.fill();
    this.s('#008870',1); c.beginPath();
    c.moveTo(80,78+bob); c.lineTo(90,88+bob); c.lineTo(80,98+bob); c.lineTo(70,88+bob);
    c.closePath(); c.stroke();
    // gem shine
    this.f('rgba(200,255,244,.75)');
    c.beginPath(); c.moveTo(80,80+bob); c.lineTo(86,86+bob); c.lineTo(80,86+bob); c.closePath(); c.fill();
  }

  // ── sleeve ────────────────────────────────────────────────────────────────
  private sleeve(side:-1|1, bob:number, A:number) {
    const c=this.cx;
    const lx = side===1?52:108, tx=side===1?18:142, ty=118;
    const mg=c.createLinearGradient(lx,72+bob,tx,ty+bob);
    mg.addColorStop(0,'#DCA820'); mg.addColorStop(.5,'#F0C840'); mg.addColorStop(1,'#C89018');
    c.fillStyle=mg;
    c.beginPath(); c.moveTo(lx,76+bob);
    if(side===1){
      this.bez(lx,76+bob, 40,88+A, 26,106+A, tx,ty+A+bob);
      this.bez(tx,ty+A+bob, tx+8,ty+4+A+bob, tx+16,ty+2+A+bob, lx-6,104+A+bob);
    } else {
      this.bez(lx,76+bob, 120,88+A, 134,106+A, tx,ty+A+bob);
      this.bez(tx,ty+A+bob, tx-8,ty+4+A+bob, tx-16,ty+2+A+bob, lx+6,104+A+bob);
    }
    this.bez(lx+(side===1?-6:6),104+A+bob, lx+(side===1?-4:4),90, lx+(side===1?-2:2),80, lx,76+bob);
    c.fill();
    // bell cuff
    const cx2=side===1?tx+4:tx-4;
    const gc=c.createRadialGradient(cx2,ty+A+bob+2,2,cx2,ty+A+bob+2,10);
    gc.addColorStop(0,'rgba(255,246,214,.85)'); gc.addColorStop(1,'rgba(255,238,180,.2)');
    c.fillStyle=gc;
    c.beginPath(); c.ellipse(cx2,ty+A+bob+2,side===1?11:11,5,-.15*side,0,Math.PI*2); c.fill();
    // cuff edge
    this.s('#C89820',.8);
    c.beginPath(); c.ellipse(cx2,ty+A+bob+2,side===1?11:11,5,-.15*side,0,Math.PI*2); c.stroke();
    // hand
    this.f('#FFDDB8');
    c.beginPath(); c.ellipse(cx2+(side===1?-2:2),ty+A+bob+7,5.5,5,-.1*side,0,Math.PI*2); c.fill();
  }

  // ── neck ─────────────────────────────────────────────────────────────────
  private neck(bob:number) {
    const ng=this.cx.createLinearGradient(72,60+bob,88,72+bob);
    ng.addColorStop(0,'#FFE8CA'); ng.addColorStop(1,'#FFD0A0');
    this.cx.fillStyle=ng;
    this.cx.beginPath(); this.cx.ellipse(80,67+bob,8.5,7,0,0,Math.PI*2); this.cx.fill();
  }

  // ── back hair panels (behind face) ───────────────────────────────────────
  private hairBack() {
    const c=this.cx;
    this.f('#160802');
    // right panel
    c.beginPath(); c.moveTo(104,20);
    this.bez(104,20,122,32,126,64,122,108);
    this.bez(122,108,120,124,116,132,112,134);
    this.bez(112,134,106,124,104,106,106,78);
    this.bez(106,78,108,52,106,28,104,20);
    c.closePath(); c.fill();
    // left panel
    c.beginPath(); c.moveTo(56,20);
    this.bez(56,20,38,32,34,64,38,108);
    this.bez(38,108,40,124,44,132,48,134);
    this.bez(48,134,54,124,56,106,54,78);
    this.bez(54,78,52,52,54,28,56,20);
    c.closePath(); c.fill();
    // sheen on hair panels
    this.f('rgba(80,28,8,.32)');
    c.beginPath(); c.moveTo(56,20);
    this.bez(56,20,50,30,46,52,48,80);
    this.bez(48,80,50,70,52,48,56,28);
    c.closePath(); c.fill();
    c.beginPath(); c.moveTo(104,20);
    this.bez(104,20,110,30,114,52,112,80);
    this.bez(112,80,110,70,108,48,104,28);
    c.closePath(); c.fill();
  }

  // ── face ─────────────────────────────────────────────────────────────────
  private face() {
    const c=this.cx;
    const fg=c.createRadialGradient(78,38,6,80,40,30);
    fg.addColorStop(0,'#FFF4E0'); fg.addColorStop(.7,'#FFE4C0'); fg.addColorStop(1,'#FFD0A0');
    c.fillStyle=fg;
    c.beginPath(); c.ellipse(80,40,26,30,0,0,Math.PI*2); c.fill();
  }

  // ── hair top ─────────────────────────────────────────────────────────────
  private hairTop() {
    const c=this.cx;
    this.f('#160802');
    // main dome
    c.beginPath(); c.ellipse(80,16,32,22,0,0,Math.PI*2); c.fill();
    // bangs flowing down
    c.beginPath();
    c.moveTo(50,26); this.bez(50,26,54,10,64,16,66,36);
    c.lineTo(94,36); this.bez(94,36,96,16,106,10,110,26);
    c.lineTo(110,36); c.lineTo(50,36); c.closePath(); c.fill();
    // hair sheen
    this.f('rgba(88,30,8,.36)');
    c.beginPath(); c.ellipse(70,12,14,8,-.22,0,Math.PI*2); c.fill();
    c.beginPath(); c.ellipse(90,10,10,6,.15,0,Math.PI*2); c.fill();
  }

  // ── hair ornament ─────────────────────────────────────────────────────────
  private ornament() {
    const c=this.cx;
    // gold chain to feather
    this.s('#C89820',1.2);
    c.beginPath(); c.moveTo(100,18); this.bez(100,18,110,14,118,10,122,6); c.stroke();
    // feather shape
    this.f('#D0A018');
    c.beginPath(); c.moveTo(100,18);
    this.bez(100,18,112,8,128,-2,130,4);
    this.bez(130,4,122,10,112,14,106,20);
    c.closePath(); c.fill();
    this.f('#ECB830');
    c.beginPath(); c.moveTo(102,17);
    this.bez(102,17,112,9,124,1,126,5);
    this.bez(126,5,118,10,110,13,104,19);
    c.closePath(); c.fill();
    // light fronds
    this.s('rgba(240,200,60,.65)',0.7);
    for(let i=0;i<4;i++){
      const t=i/3, px=102+t*22, py=17-t*10;
      c.beginPath(); c.moveTo(px,py);
      c.bezierCurveTo(px+2,py-5,px+5,py-7,px+6,py-4); c.stroke();
    }
    // teal gem on hair
    const gm=c.createRadialGradient(100,20,1,100,20,6);
    gm.addColorStop(0,'#A0FFF0'); gm.addColorStop(.5,'#20D4B0'); gm.addColorStop(1,'#008870');
    c.fillStyle=gm; c.beginPath(); c.arc(100,20,5.5,0,Math.PI*2); c.fill();
    this.f('rgba(200,255,248,.8)'); c.beginPath(); c.arc(98,18,1.8,0,Math.PI*2); c.fill();
    // forehead gem (小额心)
    const fg2=c.createRadialGradient(80,52,1,80,52,5);
    fg2.addColorStop(0,'#B0FFE8'); fg2.addColorStop(1,'#18B898');
    c.fillStyle=fg2; c.beginPath(); c.arc(80,52,4.5,0,Math.PI*2); c.fill();
    this.f('#D0A820'); c.beginPath(); c.arc(80,52,3,0,Math.PI*2); c.fill();
    this.f('#20D0A8'); c.beginPath(); c.arc(80,52,1.8,0,Math.PI*2); c.fill();
    this.f('rgba(255,255,220,.8)'); c.beginPath(); c.arc(79,51,0.8,0,Math.PI*2); c.fill();
  }

  // ── eyes ─────────────────────────────────────────────────────────────────
  private eyes() {
    const c=this.cx; const eyes:Array<[number,number]>=[[66,38],[94,38]];
    eyes.forEach(([ex,ey])=>{
      // white sclera
      this.f('white');
      c.beginPath(); c.ellipse(ex,ey,11,13,0,0,Math.PI*2); c.fill();
      // outer socket / dark ring
      this.s('#080E08',1.6); this.elS(ex,ey,11,13);
      // iris gradient
      const ig=c.createRadialGradient(ex-2,ey-2,1,ex,ey,9);
      ig.addColorStop(0,'#A8F0D0'); ig.addColorStop(.3,'#58C898'); ig.addColorStop(.7,'#2A7050'); ig.addColorStop(1,'#103828');
      c.fillStyle=ig; c.beginPath(); c.ellipse(ex,ey+1,8,10,0,0,Math.PI*2); c.fill();
      // pupil
      this.f('#060E06'); c.beginPath(); c.ellipse(ex,ey+1,3.5,5.5,0,0,Math.PI*2); c.fill();
      // main shine (large)
      this.f('rgba(255,255,255,.96)');
      c.beginPath(); c.ellipse(ex-3.5,ey-3,4,3,-.5,0,Math.PI*2); c.fill();
      // small lower shine
      this.f('rgba(255,255,255,.62)');
      c.beginPath(); c.arc(ex+3,ey+3.5,1.8,0,Math.PI*2); c.fill();
      // upper lash - thick arc
      this.s('#060A06',2.4);
      c.beginPath(); c.moveTo(ex-11,ey-4);
      c.bezierCurveTo(ex-7,ey-10,ex+7,ey-10,ex+11,ey-4); c.stroke();
      // lash flicks
      this.s('#060A06',1.4);
      [[-11,-4,-14,-8],[11,-4,14,-8],[0,-10,-2,-14],[5,-9,6,-13],[-5,-9,-6,-13]].forEach(([sx,sy,ex2,ey2])=>{
        c.beginPath(); c.moveTo(ex+sx,ey+sy); c.lineTo(ex+ex2,ey+ey2); c.stroke();
      });
      // lower lash subtle line
      this.s('rgba(8,20,8,.4)',.8);
      c.beginPath(); c.arc(ex,ey,11.5,.1,Math.PI-.1); c.stroke();
    });
    // inner corner accent
    this.f('rgba(255,160,140,.45)');
    c.beginPath(); c.ellipse(55,38,4,2.5,0,0,Math.PI*2); c.fill();
    c.beginPath(); c.ellipse(105,38,4,2.5,0,0,Math.PI*2); c.fill();
  }

  // ── face details ─────────────────────────────────────────────────────────
  private faceDetails() {
    const c=this.cx;
    // blush
    this.f('rgba(255,120,100,.24)');
    c.beginPath(); c.ellipse(52,48,11,6,-.2,0,Math.PI*2); c.fill();
    c.beginPath(); c.ellipse(108,48,11,6,.2,0,Math.PI*2); c.fill();
    // nose bridge shadow
    this.f('rgba(195,135,95,.28)');
    c.beginPath(); c.arc(80,55,2.2,0,Math.PI*2); c.fill();
    // lips
    this.f('#D84040');
    c.beginPath(); c.moveTo(70,62);
    c.bezierCurveTo(74,67,86,67,90,62);
    c.bezierCurveTo(86,65,74,65,70,62); c.closePath(); c.fill();
    // upper lip bow
    this.f('#C83838');
    c.beginPath(); c.moveTo(70,62); c.bezierCurveTo(74,58,80,60,80,62);
    c.bezierCurveTo(80,60,86,58,90,62);
    c.bezierCurveTo(86,62,74,62,70,62); c.closePath(); c.fill();
    // lip shine
    this.f('rgba(255,200,195,.55)');
    c.beginPath(); c.ellipse(80,60.5,6,1.8,0,0,Math.PI*2); c.fill();
  }

  // ── SIT ──────────────────────────────────────────────────────────────────
  private drawSit() {
    const c = this.cx;
    if (this.facing < 0) { c.save(); c.translate(W, 0); c.scale(-1, 1); }

    // Seated pose: upper body normal, legs bent forward, lower on canvas
    const bob = Math.sin(this.elapsed * 1.4) * 1.5; // gentle breathing

    // ── Legs (drawn first, behind gown hem) ─────────────────────────────
    // Upper leg going forward-down
    const lg = c.createLinearGradient(60, 168, 80, 220);
    lg.addColorStop(0, '#FFD4A0'); lg.addColorStop(1, '#FFC080');
    c.fillStyle = lg;
    // Left thigh
    c.beginPath(); c.moveTo(58, 170+bob); c.lineTo(72, 170+bob);
    c.lineTo(68, 210+bob); c.lineTo(54, 210+bob); c.closePath(); c.fill();
    // Right thigh
    c.beginPath(); c.moveTo(88, 170+bob); c.lineTo(102, 170+bob);
    c.lineTo(106, 210+bob); c.lineTo(92, 210+bob); c.closePath(); c.fill();
    // Lower legs (hanging down from knees)
    c.fillStyle = '#FFD4A0';
    c.beginPath(); c.moveTo(54, 210+bob); c.lineTo(68, 210+bob);
    c.lineTo(66, 238); c.lineTo(52, 238); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(92, 210+bob); c.lineTo(106, 210+bob);
    c.lineTo(104, 238); c.lineTo(90, 238); c.closePath(); c.fill();
    // Shoes
    this._shoe(59, 228, false);
    this._shoe(97, 228, false);

    // ── Gown (shortened seated hem) ─────────────────────────────────────
    const gd = c.createLinearGradient(80, 112+bob, 80, 210);
    gd.addColorStop(0, '#C8960E'); gd.addColorStop(0.15, '#FFF4DC');
    gd.addColorStop(0.6, '#FDFFF8'); gd.addColorStop(1, '#D4F0E4');
    c.fillStyle = gd;
    c.beginPath(); c.moveTo(52, 114+bob);
    c.bezierCurveTo(46, 138, 36, 162, 34, 210);
    c.lineTo(126, 210);
    c.bezierCurveTo(124, 162, 114, 138, 108, 114+bob);
    c.closePath(); c.fill();

    // ── Gown embroidery ─────────────────────────────────────────────────
    this.s('#A86808', 0.9);
    c.beginPath(); c.moveTo(68, 116+bob);
    c.bezierCurveTo(64, 148, 62, 174, 62, 208); c.stroke();
    c.beginPath(); c.moveTo(92, 116+bob);
    c.bezierCurveTo(96, 148, 98, 174, 98, 208); c.stroke();

    // ── Hands resting on lap ─────────────────────────────────────────────
    this.f('#FFDDB8');
    c.beginPath(); c.ellipse(62, 174+bob, 9, 6, 0.3, 0, Math.PI*2); c.fill();
    c.beginPath(); c.ellipse(98, 174+bob, 9, 6, -0.3, 0, Math.PI*2); c.fill();

    // ── Upper body (reuse shared methods) ───────────────────────────────
    this.bodice(bob);
    this.sleeve(-1, bob, 12);   // arms angled down toward lap
    this.sleeve(1,  bob, 12);
    this.neck(bob);
    this.hairBack();
    this.face();
    this.hairTop();
    this.ornament();
    this.eyes();
    this.faceDetails();

    if (this.facing < 0) c.restore();
  }

  // ── FRONT ────────────────────────────────────────────────────────────────
  private drawFront(fr:number, idle:boolean) {
    const c=this.cx;
    if(this.facing<0){c.save();c.translate(W,0);c.scale(-1,1);}
    const A1=idle?0:([0,-6,0,6][fr]), A2=idle?0:([0,6,0,-6][fr]);
    const bob=idle?0:([0,1.5,3,1.5][fr]), sw=idle?0:([0,1.5,0,-1.5][fr]);
    this.gown(bob,sw);
    this.bodice(bob);
    this.sleeve(-1,bob,A1);
    this.sleeve(1,bob,A2);
    this.neck(bob);
    this.hairBack();
    this.face();
    this.hairTop();
    this.ornament();
    this.eyes();
    this.faceDetails();
    if(this.facing<0) c.restore();
  }

  // ── BACK ─────────────────────────────────────────────────────────────────
  private drawBack(fr:number, idle:boolean) {
    const c=this.cx;
    if(this.facing<0){c.save();c.translate(W,0);c.scale(-1,1);}
    const A1=idle?0:([0,-6,0,6][fr]), A2=idle?0:([0,6,0,-6][fr]);
    const bob=idle?0:([0,1.5,3,1.5][fr]), sw=idle?0:([0,1.5,0,-1.5][fr]);
    // gown back
    const gd=c.createLinearGradient(80,112+bob,80,238);
    gd.addColorStop(0,'#B88A0C'); gd.addColorStop(.12,'#D4A020');
    gd.addColorStop(.3,'#F8EED4'); gd.addColorStop(1,'#D0EEE4');
    c.fillStyle=gd;
    c.beginPath(); c.moveTo(52,112+bob);
    this.bez(52,112+bob,38+sw,138,12+sw,178,8,238);
    c.lineTo(152,238);
    this.bez(152,238,148-sw,178,122-sw,138,108,112+bob);
    c.closePath(); c.fill();
    this.s('#906008',.9);
    c.beginPath(); c.moveTo(68,114+bob); this.bez(68,114+bob,64,152,60,184,58,228); c.stroke();
    c.beginPath(); c.moveTo(92,114+bob); this.bez(92,114+bob,96,152,100,184,102,228); c.stroke();
    // back bodice
    const bg=c.createLinearGradient(50,70+bob,110,114+bob);
    bg.addColorStop(0,'#C48808'); bg.addColorStop(1,'#D49010');
    c.fillStyle=bg; c.beginPath();
    c.moveTo(50,72+bob); c.lineTo(110,72+bob); c.lineTo(114,114+bob); c.lineTo(46,114+bob); c.closePath(); c.fill();
    this.s('rgba(130,68,8,.5)',1); c.beginPath(); c.moveTo(80,72+bob); c.lineTo(80,114+bob); c.stroke();
    // sleeves back
    this.sleeve(-1,bob,A1); this.sleeve(1,bob,A2);
    this.neck(bob);
    // massive flowing back hair
    this.f('#160802');
    c.beginPath(); c.ellipse(80,16,34,24,0,0,Math.PI*2); c.fill();
    // right lock
    c.beginPath(); c.moveTo(106,22);
    this.bez(106,22,128,38,136,78,130,128);
    this.bez(130,128,128,142,124,148,120,148);
    this.bez(120,148,114,142,112,126,116,96);
    this.bez(116,96,122,68,118,38,106,22); c.closePath(); c.fill();
    // left lock
    c.beginPath(); c.moveTo(54,22);
    this.bez(54,22,32,38,24,78,30,128);
    this.bez(30,128,32,142,36,148,40,148);
    this.bez(40,148,46,142,48,126,44,96);
    this.bez(44,96,38,68,42,38,54,22); c.closePath(); c.fill();
    // center stream
    c.beginPath(); c.moveTo(72,36); c.lineTo(88,36);
    this.bez(88,36,90,80,88,130,84,168);
    c.bezierCurveTo(83,176,77,176,76,168);
    this.bez(76,168,72,130,70,80,72,36); c.closePath(); c.fill();
    // hair shine
    this.f('rgba(76,26,6,.38)');
    c.beginPath(); c.ellipse(72,14,14,9,-.26,0,Math.PI*2); c.fill();
    c.beginPath(); c.ellipse(90,11,9,5,.18,0,Math.PI*2); c.fill();
    this.ornament();
    if(this.facing<0) c.restore();
  }

  // ── shoe helper ──────────────────────────────────────────────────────────
  private _shoe(x:number, y:number, isBack:boolean) {
    const c=this.cx;
    // drop shadow
    this.f('rgba(0,0,0,.14)');
    c.beginPath(); c.ellipse(x+1,y+10,14,4.5,0,0,Math.PI*2); c.fill();
    // slipper body
    const sg=c.createLinearGradient(x-14,y,x+14,y+13);
    sg.addColorStop(0,isBack?'#8A6005':'#C8900C');
    sg.addColorStop(1,isBack?'#604003':'#906006');
    c.fillStyle=sg;
    c.beginPath(); c.moveTo(x-14,y+7);
    c.bezierCurveTo(x-13,y+1,x+8,y+1,x+15,y+7);
    c.bezierCurveTo(x+15,y+13,x-14,y+13,x-14,y+7);
    c.closePath(); c.fill();
    // toe shine
    this.f('rgba(255,228,110,.52)');
    c.beginPath(); c.ellipse(x+8,y+5,5.5,2.5,-.3,0,Math.PI*2); c.fill();
    // heel accent
    this.f(isBack?'rgba(100,70,4,.45)':'rgba(160,100,8,.45)');
    c.beginPath(); c.ellipse(x-10,y+8,4,3.5,0,0,Math.PI*2); c.fill();
  }

  // ── SIDE ─────────────────────────────────────────────────────────────────
  private drawSide(fr:number, idle:boolean) {
    const c=this.cx;
    if(this.facing<0){c.save();c.translate(W,0);c.scale(-1,1);}
    const aF=idle?0:([0,-10,0,10][fr]), aB=idle?0:([0,10,0,-10][fr]);
    const bob=idle?0:([0,2.5,4.5,2.5][fr]);
    // foot stride per frame: front foot x-offset, back foot x-offset, front lift, back lift
    const fFwd  = idle?0:([  0,+16,  0, -8][fr]);
    const bFwd  = idle?0:([  0, -8,  0,+14][fr]);
    const fLift = idle?0:([  0, -9,  0,  0][fr]);
    const bLift = idle?0:([  0,  0,  0, -8][fr]);
    const hemY  = 212;
    // BACK FOOT drawn before gown
    this._shoe(62+bFwd, hemY+14+bLift, true);
    // gown side (hem raised to hemY to expose feet)
    const gd=c.createLinearGradient(80,112+bob,80,hemY);
    gd.addColorStop(0,'#C8960E'); gd.addColorStop(.2,'#FFF0D0'); gd.addColorStop(1,'#E4F8F0');
    c.fillStyle=gd;
    c.beginPath(); c.moveTo(54,112+bob);
    this.bez(54,112+bob,52,142,46,178,40,hemY);
    c.lineTo(140,hemY);
    this.bez(140,hemY,134,178,134,142,112,112+bob);
    c.closePath(); c.fill();
    // gown sheen
    const sl=c.createLinearGradient(24,118+bob,72,162);
    sl.addColorStop(0,'rgba(255,255,220,.48)'); sl.addColorStop(1,'rgba(255,255,220,0)');
    c.fillStyle=sl;
    c.beginPath(); c.moveTo(54,112+bob);
    this.bez(54,112+bob,50,140,46,170,42,hemY-6);
    c.lineTo(66,hemY-6); this.bez(66,hemY-6,60,174,58,144,62,116+bob);
    c.closePath(); c.fill();
    // embroidery lines
    this.s('#A86808',.8);
    c.beginPath(); c.moveTo(72,114+bob); this.bez(72,114+bob,70,152,68,182,66,hemY-2); c.stroke();
    c.beginPath(); c.moveTo(96,114+bob); this.bez(96,114+bob,100,152,102,184,102,hemY-2); c.stroke();
    // hem fringe undulation
    const hs=idle?0:([0,2.5,0,-2.5][fr]);
    this.f('rgba(200,158,18,.3)');
    c.beginPath(); c.moveTo(40,hemY);
    for(let i=0;i<=10;i++){ c.lineTo(40+i*10+(i%2?-hs:hs), hemY+(i%2?2.5:-1)); }
    c.lineTo(140,hemY); c.closePath(); c.fill();
    // FRONT FOOT drawn after gown (appears in front)
    this._shoe(112+fFwd, hemY+16+fLift, false);
    // back arm (behind body)
    const mg2=c.createLinearGradient(108,76+bob,142,118+bob);
    mg2.addColorStop(0,'#C89010'); mg2.addColorStop(1,'#E0A828');
    c.fillStyle=mg2;
    c.beginPath(); c.moveTo(108,78+bob);
    this.bez(108,78+bob,120,88+aB,134,108+aB,138,118+aB+bob);
    this.bez(138,118+aB+bob,134,124+aB+bob,128,122+aB+bob,124,116+aB+bob);
    this.bez(124,116+aB+bob,122,106+aB,114,90,106,82+bob);
    c.closePath(); c.fill();
    this.f('#FFE0B8'); c.beginPath(); c.ellipse(136,120+aB+bob,10,5,-.2,0,Math.PI*2); c.fill();
    this.f('#FFD8B0'); c.beginPath(); c.ellipse(136,125+aB+bob,7,5,-.2,0,Math.PI*2); c.fill();
    // side bodice
    const bg2=c.createLinearGradient(56,70+bob,116,114+bob);
    bg2.addColorStop(0,'#DCAC28'); bg2.addColorStop(1,'#F0C840');
    c.fillStyle=bg2; c.beginPath();
    c.moveTo(56,72+bob); c.lineTo(112,72+bob); c.lineTo(116,114+bob); c.lineTo(50,114+bob); c.closePath(); c.fill();
    this.s('#A87808',.9); c.beginPath(); c.moveTo(84,72+bob); c.lineTo(86,114+bob); c.stroke();
    // front arm
    const mg3=c.createLinearGradient(52,76+bob,18,118+bob);
    mg3.addColorStop(0,'#E8B030'); mg3.addColorStop(1,'#F8D050');
    c.fillStyle=mg3;
    c.beginPath(); c.moveTo(58,78+bob);
    this.bez(58,78+bob,46,88+aF,30,108+aF,26,118+aF+bob);
    this.bez(26,118+aF+bob,30,124+aF+bob,36,122+aF+bob,40,116+aF+bob);
    this.bez(40,116+aF+bob,42,106+aF,50,90,56,82+bob);
    c.closePath(); c.fill();
    this.f('#FFE0B8'); c.beginPath(); c.ellipse(28,120+aF+bob,10,5,.2,0,Math.PI*2); c.fill();
    this.f('#FFD8B0'); c.beginPath(); c.ellipse(28,125+aF+bob,7,5,.2,0,Math.PI*2); c.fill();
    // neck side
    const ng2=c.createLinearGradient(76,60+bob,90,72+bob);
    ng2.addColorStop(0,'#FFE8CA'); ng2.addColorStop(1,'#FFD0A0');
    c.fillStyle=ng2; c.beginPath(); c.ellipse(84,67+bob,9,7,0,0,Math.PI*2); c.fill();
    // side hair (long, flowing behind)
    this.f('#160802');
    c.beginPath(); c.moveTo(76,24);
    this.bez(76,24,56,28,40,52,34,90);
    this.bez(34,90,32,116,36,140,42,148);
    this.bez(42,148,50,152,54,140,52,118);
    this.bez(52,118,50,90,54,60,66,30);
    c.closePath(); c.fill();
    this.f('rgba(72,24,6,.34)');
    c.beginPath(); c.moveTo(66,30);
    this.bez(66,30,52,42,46,68,48,96);
    this.bez(48,80,50,54,62,34,66,30); c.closePath(); c.fill();
    // side face
    const fg2=c.createRadialGradient(90,38,5,90,40,28);
    fg2.addColorStop(0,'#FFF4E0'); fg2.addColorStop(.6,'#FFE4C2'); fg2.addColorStop(1,'#FFD0A0');
    c.fillStyle=fg2;
    c.beginPath(); c.moveTo(76,8);
    this.bez(76,8,100,8,114,18,116,34);
    this.bez(116,34,116,52,110,64,102,68);
    c.lineTo(76,68); c.closePath(); c.fill();
    // side hair top
    this.f('#160802');
    c.beginPath(); c.ellipse(84,16,32,24,0,0,Math.PI*2); c.fill();
    c.beginPath();
    c.moveTo(70,28); this.bez(70,28,76,8,92,12,96,32);
    c.lineTo(96,38); c.lineTo(70,38); c.closePath(); c.fill();
    this.f('rgba(76,26,6,.36)'); c.beginPath(); c.ellipse(78,12,14,8,0,0,Math.PI*2); c.fill();
    // ornament side
    this.f('#C89818');
    c.beginPath(); c.moveTo(98,18);
    this.bez(98,18,110,12,120,6,122,10);
    this.bez(122,10,114,14,106,18,102,22);
    c.closePath(); c.fill();
    this.f('#F0C030');
    c.beginPath(); c.moveTo(100,17);
    this.bez(100,17,110,11,118,7,120,11);
    this.bez(120,11,112,14,104,18,100,21);
    c.closePath(); c.fill();
    this.f('#18C8A8'); c.beginPath(); c.arc(98,20,5,0,Math.PI*2); c.fill();
    this.f('rgba(200,255,248,.78)'); c.beginPath(); c.arc(96,18,1.8,0,Math.PI*2); c.fill();
    // side eye (single, profile)
    this.f('white'); c.beginPath(); c.ellipse(104,36,9,11,.15,0,Math.PI*2); c.fill();
    this.s('#060C06',1.5); this.elS(104,36,9,11,.15);
    const ie=c.createRadialGradient(102,34,1,104,36,8);
    ie.addColorStop(0,'#A8F0D0'); ie.addColorStop(.4,'#50C090'); ie.addColorStop(1,'#1A5830');
    c.fillStyle=ie; c.beginPath(); c.ellipse(104,37,6,8,.15,0,Math.PI*2); c.fill();
    this.f('#060E06'); c.beginPath(); c.ellipse(105,37,2.8,4.5,.15,0,Math.PI*2); c.fill();
    this.f('rgba(255,255,255,.95)'); c.beginPath(); c.ellipse(101,33,3.5,2.5,-.4,0,Math.PI*2); c.fill();
    this.f('rgba(255,255,255,.6)'); c.beginPath(); c.arc(107,40,1.6,0,Math.PI*2); c.fill();
    this.s('#060C06',2.2);
    c.beginPath(); c.moveTo(94,26); this.bez(94,26,96,22,110,22,114,26); c.stroke();
    this.s('#060C06',1.2);
    [[94,26,90,22],[114,26,118,22],[104,25,102,20],[108,24,107,19]].forEach(([sx,sy,ex2,ey2])=>{
      c.beginPath(); c.moveTo(sx,sy); c.lineTo(ex2,ey2); c.stroke();
    });
    // nose side
    this.f('#D8A070'); c.beginPath(); c.arc(113,48,3,Math.PI*.2,Math.PI*.9); c.fill();
    this.f('#FFDCB8'); c.beginPath(); c.ellipse(113,50,3.5,4,0,0,Math.PI*2); c.fill();
    // blush side
    this.f('rgba(255,120,100,.22)'); c.beginPath(); c.ellipse(104,52,9,4,.1,0,Math.PI*2); c.fill();
    // mouth side
    this.f('#D84040');
    c.beginPath(); c.moveTo(102,62); this.bez(102,62,108,66,114,66,116,62);
    this.bez(116,62,114,64,108,64,102,62); c.closePath(); c.fill();
    this.f('#C03030');
    c.beginPath(); c.moveTo(102,62); this.bez(102,62,108,58,114,58,116,62);
    this.bez(116,62,114,62,108,62,102,62); c.closePath(); c.fill();
    if(this.facing<0) c.restore();
  }
}
