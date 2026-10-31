/**
 * 📌 What a room board's face shows (#315): the corkboard's cork with its
 * pinned notes, or the notice case's felt behind the glass. The board's
 * builder (furniture.ts) paints this on its CanvasTexture whenever World's
 * 1 Hz status push brings a different BoardScreen (boardDoc.readBoardScreen);
 * the focused panel (boardUI.ts) is where notes are read in full and posted.
 *
 * A note the reader hasn't seen yet glows (Dorkmo 2026-10-31: no count
 * anywhere; the glow stays until they walk up to the board and look). A note
 * with a photo pins up as a Polaroid: the shot itself once the viewer's node
 * holds it (boardPhotos.ts), else a frame that says why it isn't there yet.
 *
 * Pure apart from the 2D context it is handed, and free of three.js, so a
 * test can paint it onto a fake canvas.
 */

import type { BoardColour, BoardFaceNote, BoardScreen, PhotoLook } from './boardDoc';

/** A photo's decoded picture by its hash, when the page holds it. */
export type PictureOf = (hash: string) => { img: CanvasImageSource & { width: number; height: number } } | null;

/** What a Polaroid's frame says while its picture isn't there. */
export const PHOTO_LOOK_LINES: Readonly<Record<Exclude<PhotoLook, 'ready'>, readonly [string, string]>> = {
  loading: ['PHOTO', 'LOADING…'],
  fetch: ['WALK UP', 'TO FETCH'],
  unreachable: ['SHARER NOT', 'REACHABLE'],
  'no-node': ['NEEDS THE', 'DESKTOP APP'],
};

/** The face's layout size (canvas units); the canvas is this times BOARD_FACE_SCALE. */
export const BOARD_FACE_W = 528;
export const BOARD_FACE_H = 384;
/** Pixels per layout unit, so note text stays sharp a pace away. */
export const BOARD_FACE_SCALE = 2;

export type BoardLook = 'cork' | 'felt';

/** Paper colours (the post box's swatches use the same). */
export const NOTE_FILL: Readonly<Record<BoardColour, string>> = {
  yellow: '#F7E27A',
  pink: '#F6A8C8',
  blue: '#A4CFF2',
  green: '#AEE2A4',
  orange: '#F7B46A',
  white: '#F4F1E8',
};

const NOTE = 68; // a paper note's side
const POLAROID_W = 64;
const POLAROID_H = 76;
/** The case's brass header strip. */
const FELT_HEADER = 30;
const INK = '#2A2418';

/** A small fixed-seed PRNG: the cork's grain looks the same on every board
 *  and every redraw. */
function grain(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A note's tilt, from its id: the same on every screen, never twice in a row. */
export function noteTilt(id: string): number {
  const n = parseInt(id.slice(0, 2), 16);
  return Number.isFinite(n) ? ((n / 255) - 0.5) * 0.16 : 0;
}

/** Word-wrap `text` into at most `maxLines` lines no wider than `maxW`. */
export function wrapNoteText(
  measure: (s: string) => number,
  text: string,
  maxW: number,
  maxLines: number,
): string[] {
  if (maxLines < 1) return [];
  const lines: string[] = [];
  const paragraphs = text.split('\n');
  for (let p = 0; p < paragraphs.length; p++) {
    let line = '';
    for (const word of paragraphs[p].split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= maxW) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      if (lines.length >= maxLines) return clipLast(lines, measure, maxW);
      // A word wider than the note is cut where it stops fitting.
      let cut = word;
      while (cut.length > 1 && measure(cut) > maxW) cut = cut.slice(0, -1);
      line = cut;
    }
    if (line) lines.push(line);
    const more = paragraphs.slice(p + 1).some((q) => q.trim().length > 0);
    if (lines.length >= maxLines && more) return clipLast(lines, measure, maxW);
    if (lines.length >= maxLines) return lines.slice(0, maxLines);
  }
  return lines;
}

function clipLast(lines: string[], measure: (s: string) => number, maxW: number): string[] {
  let last = lines[lines.length - 1] ?? '';
  while (last.length > 1 && measure(`${last}…`) > maxW) last = last.slice(0, -1);
  lines[lines.length - 1] = `${last}…`;
  return lines;
}

/** Where the notes sit: the whole cork, or the felt under the case's header. */
function noteArea(look: BoardLook): { top: number; h: number } {
  return look === 'felt'
    ? { top: FELT_HEADER, h: BOARD_FACE_H - FELT_HEADER }
    : { top: 0, h: BOARD_FACE_H };
}

function paintBackground(c: CanvasRenderingContext2D, look: BoardLook): void {
  const W = BOARD_FACE_W;
  const H = BOARD_FACE_H;
  const rand = grain(look === 'felt' ? 0x5eed : 0xc0c0);
  if (look === 'cork') {
    c.fillStyle = '#B88A58';
    c.fillRect(0, 0, W, H);
    // Cork grain: small light and dark flecks.
    for (let i = 0; i < 520; i++) {
      c.fillStyle = rand() < 0.5 ? 'rgba(90,58,30,0.35)' : 'rgba(232,196,146,0.35)';
      c.fillRect(rand() * W, rand() * H, 1 + rand() * 2.5, 1 + rand() * 2);
    }
    return;
  }
  c.fillStyle = '#22344E';
  c.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    c.fillStyle = rand() < 0.5 ? 'rgba(10,18,32,0.35)' : 'rgba(70,96,130,0.25)';
    c.fillRect(rand() * W, rand() * H, 1 + rand() * 2, 1 + rand() * 2);
  }
  // The brass header strip: NOTICES.
  c.fillStyle = '#B8923E';
  c.fillRect(0, 0, W, FELT_HEADER - 4);
  c.fillStyle = '#8C6C28';
  c.fillRect(0, FELT_HEADER - 6, W, 2);
  c.font = 'bold 15px Georgia, serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#2A1E08';
  c.fillText('NOTICES', W / 2, (FELT_HEADER - 4) / 2 + 1);
}

function paintPin(c: CanvasRenderingContext2D, x: number, y: number, look: BoardLook): void {
  c.fillStyle = 'rgba(0,0,0,0.25)';
  c.beginPath();
  c.arc(x + 1.5, y + 1.5, 4, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = look === 'felt' ? '#D8B45A' : '#D23C3C';
  c.beginPath();
  c.arc(x, y, 4, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.beginPath();
  c.arc(x - 1.2, y - 1.2, 1.3, 0, Math.PI * 2);
  c.fill();
}

/** The glow on a note this reader hasn't seen: a warm halo round the paper. */
function glow(c: CanvasRenderingContext2D, w: number, h: number): void {
  c.save();
  c.shadowColor = 'rgba(255, 236, 140, 0.95)';
  c.shadowBlur = 16;
  c.fillStyle = 'rgba(255, 244, 190, 0.9)';
  c.fillRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6);
  c.restore();
}

/** Draw `img` to fill a w × h box at (x, y), cropped to keep its shape. */
function drawCover(c: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number): void {
  const iw = img.width;
  const ih = img.height;
  if (!(iw > 0) || !(ih > 0)) return;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  c.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

function paintNote(c: CanvasRenderingContext2D, n: BoardFaceNote, look: BoardLook, pictureOf?: PictureOf): void {
  const area = noteArea(look);
  const w = n.photo ? POLAROID_W : NOTE;
  const h = n.photo ? POLAROID_H : NOTE;
  // Keep the whole note on the board.
  const cx = Math.min(BOARD_FACE_W - w / 2 - 4, Math.max(w / 2 + 4, n.x * BOARD_FACE_W));
  const cy = Math.min(area.top + area.h - h / 2 - 4, Math.max(area.top + h / 2 + 6, area.top + n.y * area.h));
  c.save();
  c.translate(cx, cy);
  c.rotate(noteTilt(n.id));
  if (n.unseen) glow(c, w, h);
  // A soft drop shadow, then the paper.
  c.fillStyle = 'rgba(0,0,0,0.28)';
  c.fillRect(-w / 2 + 2, -h / 2 + 3, w, h);
  if (n.photo) {
    c.fillStyle = '#FBFAF6';
    c.fillRect(-w / 2, -h / 2, w, h);
    // The picture: the shot once this viewer's page holds it, else a dark
    // frame with a lens ring and why it isn't there yet.
    const px = -w / 2 + 5;
    const py = -h / 2 + 5;
    const pw = w - 10;
    const ph = w - 14;
    const pic = n.attach && n.photoLook === 'ready' ? pictureOf?.(n.attach.hash) ?? null : null;
    c.fillStyle = '#3A4A5C';
    c.fillRect(px, py, pw, ph);
    if (pic) {
      drawCover(c, pic.img, px, py, pw, ph);
    } else {
      c.strokeStyle = 'rgba(220,230,240,0.35)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(0, py + ph / 2, 9, 0, Math.PI * 2);
      c.stroke();
      const lines = n.photoLook && n.photoLook !== 'ready' ? PHOTO_LOOK_LINES[n.photoLook] : null;
      if (lines) {
        c.font = 'bold 6px sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = 'rgba(230,236,244,0.9)';
        c.fillText(lines[0], 0, py + ph / 2 - 4);
        c.fillText(lines[1], 0, py + ph / 2 + 4);
      }
    }
    c.font = '7px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.fillStyle = INK;
    // The shot's own caption, else the note's words, else who pinned it.
    const line = n.attach?.caption || n.text.trim() || `— ${n.authorName}`;
    const caption = wrapNoteText((s) => c.measureText(s).width, line, w - 8, 1)[0] ?? '';
    c.fillText(caption, 0, h / 2 - 6);
  } else {
    c.fillStyle = NOTE_FILL[n.colour] ?? NOTE_FILL.yellow;
    c.fillRect(-w / 2, -h / 2, w, h);
    // A darker band where the sticky strip would be.
    c.fillStyle = 'rgba(0,0,0,0.06)';
    c.fillRect(-w / 2, -h / 2, w, 10);
    c.font = '8.5px sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.fillStyle = INK;
    // Four lines: a fifth would run into the author's name.
    const lines = wrapNoteText((s) => c.measureText(s).width, n.text, w - 10, 4);
    lines.forEach((line, i) => c.fillText(line, -w / 2 + 5, -h / 2 + 20 + i * 9.5));
    c.font = 'italic 7px sans-serif';
    c.fillStyle = 'rgba(42,36,24,0.7)';
    const by = wrapNoteText((s) => c.measureText(s).width, `— ${n.authorName}`, w - 10, 1)[0] ?? '';
    c.fillText(by, -w / 2 + 5, h / 2 - 5);
  }
  paintPin(c, 0, -h / 2 + 4, look);
  c.restore();
}

/** An index card in the middle of an empty board, saying why it's empty. */
function paintEmpty(c: CanvasRenderingContext2D, text: string, look: BoardLook): void {
  const area = noteArea(look);
  c.save();
  c.translate(BOARD_FACE_W / 2, area.top + area.h / 2);
  c.rotate(-0.03);
  c.fillStyle = 'rgba(0,0,0,0.25)';
  c.fillRect(-88, -26, 180, 56);
  c.fillStyle = '#F6F3EA';
  c.fillRect(-90, -28, 180, 56);
  c.strokeStyle = 'rgba(200,80,80,0.35)';
  c.beginPath();
  c.moveTo(-90, -14);
  c.lineTo(90, -14);
  c.stroke();
  c.font = 'bold 13px sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = INK;
  c.fillText(text, 0, 6);
  paintPin(c, 0, -22, look);
  c.restore();
}

/**
 * Paint a board's face. `c` is the canvas's 2D context, already sized to
 * BOARD_FACE_W × BOARD_FACE_H times BOARD_FACE_SCALE; nothing on `screen`
 * (not loaded yet) paints the bare board.
 */
export function paintBoardFace(c: CanvasRenderingContext2D, screen: BoardScreen | undefined, look: BoardLook, pictureOf?: PictureOf): void {
  c.setTransform(BOARD_FACE_SCALE, 0, 0, BOARD_FACE_SCALE, 0, 0);
  paintBackground(c, look);
  if (!screen) return;
  // Oldest first, so the newest notes lie on top where they overlap.
  for (const n of [...screen.notes].reverse()) paintNote(c, n, look, pictureOf);
  if (screen.notes.length === 0 && screen.empty) paintEmpty(c, screen.empty, look);
  if (screen.hiddenCount > 0) {
    c.font = '8px sans-serif';
    c.textAlign = 'right';
    c.textBaseline = 'alphabetic';
    c.fillStyle = look === 'felt' ? 'rgba(220,230,245,0.7)' : 'rgba(40,24,10,0.65)';
    c.fillText(`${screen.hiddenCount} HIDDEN BY YOU`, BOARD_FACE_W - 8, BOARD_FACE_H - 6);
  }
}

/** A cheap stand-in for "has this face changed?": the 1 Hz push repaints only
 *  when the view moves (the TV screen's rule). */
export function boardFaceKey(screen: BoardScreen | undefined): string {
  return screen ? JSON.stringify(screen) : '';
}
