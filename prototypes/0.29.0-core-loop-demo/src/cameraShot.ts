/**
 * 📷 The CAMERA app's shutter (#319): a picture of the room as the player
 * sees it, read off the game's canvas right after a frame is drawn.
 *
 * Why right after: the renderer keeps no copy of its drawing buffer
 * (`preserveDrawingBuffer` is off, as it should be for speed), so the
 * picture can be read only in the same task that drew it, before the
 * browser shows it. A shot is asked for (`requestShot`) and the render loop
 * serves it (`servePendingShot`) straight after the frame it draws.
 *
 * What it holds: the WebGL picture only. The phone, the chat bubbles and
 * every other overlay are DOM laid over the canvas, so they are never in a
 * shot; the room, its furniture and the avatars in it are. The picture is
 * scaled to fit SHOT_MAX_PX and saved as a JPEG (about 40–60 KB).
 */

/** The longest side of a shot, in pixels. */
export const SHOT_MAX_PX = 512;
/** JPEG quality of a shot. */
export const SHOT_JPEG_QUALITY = 0.82;
/** How long a shot waits for a frame before it gives up (a hidden tab
 *  draws none). */
export const SHOT_WAIT_MS = 2000;

export interface CapturedShot {
  blob: Blob;
  width: number;
  height: number;
}

/** A size scaled down to fit `max` on its longest side (never up). */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0) || !(max > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** What a shot is drawn into: an HTMLCanvasElement in the game. */
export interface ShotCanvas {
  getContext(type: '2d'): { drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void } | null;
  toBlob(callback: (blob: Blob | null) => void, type: string, quality: number): void;
}

/** What a shot is read from: the game's canvas. */
export interface ShotSource {
  width: number;
  height: number;
}

const defaultCanvas = (width: number, height: number): ShotCanvas => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas as unknown as ShotCanvas;
};

interface Waiting {
  answer: (shot: CapturedShot | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

let waiting: Waiting[] = [];

/** Whether a shot waits for the next frame. */
export function shotPending(): boolean {
  return waiting.length > 0;
}

/** A shot of the next frame drawn, or null if no frame came within
 *  `waitMs` or it couldn't be read. Once a frame is read, its encoding
 *  takes as long as it takes. */
export function requestShot(waitMs = SHOT_WAIT_MS): Promise<CapturedShot | null> {
  return new Promise((resolve) => {
    const entry: Waiting = {
      answer: resolve,
      timer: setTimeout(() => {
        waiting = waiting.filter((w) => w !== entry);
        resolve(null);
      }, waitMs),
    };
    waiting.push(entry);
  });
}

/** The render loop's half: called right after a frame is drawn, it reads
 *  the frame for every shot waiting. Does nothing when none is. */
export function servePendingShot(source: ShotSource, makeCanvas: (w: number, h: number) => ShotCanvas = defaultCanvas): void {
  if (waiting.length === 0) return;
  const answers = waiting;
  waiting = [];
  for (const w of answers) clearTimeout(w.timer);
  const done = (shot: CapturedShot | null) => {
    for (const w of answers) w.answer(shot);
  };
  const { width, height } = fitWithin(source.width, source.height, SHOT_MAX_PX);
  if (width === 0) return done(null);
  try {
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return done(null);
    ctx.drawImage(source as unknown as CanvasImageSource, 0, 0, width, height);
    canvas.toBlob((blob) => done(blob && blob.size > 0 ? { blob, width, height } : null), 'image/jpeg', SHOT_JPEG_QUALITY);
  } catch {
    done(null);
  }
}

/** Test hook: forget every waiting shot. */
export function resetShotsForTest(): void {
  for (const w of waiting) clearTimeout(w.timer);
  waiting = [];
}
