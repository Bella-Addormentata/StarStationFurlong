/**
 * 🕹️ The arcade cabinet's screen: everything that paints the cabinet's
 * in-world CanvasTexture — the running game, the game menu, the credits
 * pages and the idle attract card.
 *
 * The canvas is 512×480, exactly twice the NES's 256×240, so each NES pixel is
 * a 2×2 block and every second row can carry a scanline. On top of that sits a
 * small CRT look, kept to this one screen (the room-wide CRT vibe is issue
 * #194): dark scanlines, blacks lifted off pure black, a soft vignette, and
 * the texture's linear filtering for a little bleed between pixels.
 *
 * Frame conversion (writeFrameRgba) is pure and tested; the rest is
 * Canvas2D drawing.
 */

import { ARCADE_GAMES, LICENSE_LABEL, type ArcadeGame } from './arcadeLibrary';

export const NES_W = 256;
export const NES_H = 240;
export const SCREEN_W = NES_W * 2;
export const SCREEN_H = NES_H * 2;

/** Black sits this far above 0, like a CRT's glowing phosphor floor. */
export const BLACK_LIFT = 10;
/** Opacity of the dark line drawn over every second screen row. */
const SCANLINE_ALPHA = 0.28;

const PHOSPHOR = '#7CFFB0';
const PHOSPHOR_DIM = '#3C9F6A';
const AMBER = '#FFC860';
const BG = '#060c09';
const FONT = "'SF Mono','Consolas','Monaco',monospace";

/**
 * Convert one jsnes frame (256×240, each pixel 0xBBGGRR) to RGBA bytes,
 * lifting black by BLACK_LIFT. `out` must hold 256×240×4 bytes.
 */
export function writeFrameRgba(frame: ArrayLike<number>, out: Uint8ClampedArray, lift = BLACK_LIFT): void {
  const scale = (255 - lift) / 255;
  const n = NES_W * NES_H;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const c = frame[i];
    out[o] = lift + (c & 0xff) * scale;
    out[o + 1] = lift + ((c >> 8) & 0xff) * scale;
    out[o + 2] = lift + ((c >> 16) & 0xff) * scale;
    out[o + 3] = 255;
  }
}

export interface ArcadeMenuRow {
  label: string;
  /** Second line under the selected row (blurb / controls). */
  detail?: string[];
}

export interface ArcadeScreenPainter {
  /** Paint one emulator frame with the CRT overlay. */
  drawFrame(frame: ArrayLike<number>): void;
  /** The game menu: rows, the selected one, an optional status line. */
  drawMenu(rows: ArcadeMenuRow[], selected: number, status: string | null, blink: boolean): void;
  /** One credits page per bundled game (page ≥ games ⇒ the closing page). */
  drawCredits(page: number): void;
  /** A one-line card ("LOADING THWAITE…"). */
  drawCard(title: string, line: string): void;
  /** The idle cabinet: what everyone else in the room sees. */
  drawAttract(): void;
}

/** Pages drawCredits can show: one per bundled game plus the closing page. */
export const CREDIT_PAGES = ARCADE_GAMES.length + 1;

export function createArcadeScreenPainter(canvas: HTMLCanvasElement): ArcadeScreenPainter {
  canvas.width = SCREEN_W;
  canvas.height = SCREEN_H;
  const ctx = canvas.getContext('2d')!;

  // The NES frame lands here at native size, then scales 2× onto the screen.
  let nes: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; image: ImageData } | null = null;
  const nesSurface = () => {
    if (!nes) {
      const c = document.createElement('canvas');
      c.width = NES_W;
      c.height = NES_H;
      const cx = c.getContext('2d')!;
      nes = { canvas: c, ctx: cx, image: cx.createImageData(NES_W, NES_H) };
    }
    return nes;
  };

  // Scanlines + vignette, rendered once and laid over every paint.
  let overlay: HTMLCanvasElement | null = null;
  const crtOverlay = (): HTMLCanvasElement => {
    if (overlay) return overlay;
    overlay = document.createElement('canvas');
    overlay.width = SCREEN_W;
    overlay.height = SCREEN_H;
    const ox = overlay.getContext('2d')!;
    ox.fillStyle = `rgba(0,0,0,${SCANLINE_ALPHA})`;
    for (let y = 1; y < SCREEN_H; y += 2) ox.fillRect(0, y, SCREEN_W, 1);
    const vignette = ox.createRadialGradient?.(
      SCREEN_W / 2, SCREEN_H / 2, SCREEN_H * 0.35,
      SCREEN_W / 2, SCREEN_H / 2, SCREEN_H * 0.78,
    );
    if (vignette) {
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
      ox.fillStyle = vignette;
      ox.fillRect(0, 0, SCREEN_W, SCREEN_H);
    }
    return overlay;
  };
  const finish = () => ctx.drawImage(crtOverlay(), 0, 0);

  const clear = () => {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  };
  const text = (s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left') => {
    ctx.font = `bold ${size}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, y, SCREEN_W - 40);
  };
  const header = (title: string) => {
    text(title, SCREEN_W / 2, 54, 30, AMBER, 'center');
    ctx.fillStyle = PHOSPHOR_DIM;
    ctx.fillRect(40, 70, SCREEN_W - 80, 2);
  };

  return {
    drawFrame(frame) {
      const s = nesSurface();
      writeFrameRgba(frame, s.image.data);
      s.ctx.putImageData(s.image, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(s.canvas, 0, 0, SCREEN_W, SCREEN_H);
      finish();
    },

    drawMenu(rows, selected, status, blink) {
      clear();
      header('SSF ARCADE');
      let y = 112;
      rows.forEach((row, i) => {
        const on = i === selected;
        if (on) {
          ctx.fillStyle = 'rgba(124,255,176,0.12)';
          ctx.fillRect(28, y - 26, SCREEN_W - 56, 36);
        }
        text(on && blink ? '▶' : ' ', 40, y, 22, AMBER);
        text(row.label, 70, y, 22, on ? PHOSPHOR : PHOSPHOR_DIM);
        y += 40;
      });
      const detail = rows[selected]?.detail ?? [];
      let dy = SCREEN_H - 92;
      for (const line of detail) {
        text(line, SCREEN_W / 2, dy, 16, PHOSPHOR_DIM, 'center');
        dy += 24;
      }
      if (status) text(status, SCREEN_W / 2, SCREEN_H - 24, 18, AMBER, 'center');
      finish();
    },

    drawCredits(page) {
      clear();
      header('CREDITS & LICENSES');
      const game: ArcadeGame | undefined = ARCADE_GAMES[page];
      if (game) {
        text(game.title, SCREEN_W / 2, 120, 26, PHOSPHOR, 'center');
        text(`BY ${game.author.toUpperCase()}, ${game.year}`, SCREEN_W / 2, 160, 18, PHOSPHOR_DIM, 'center');
        text(`LICENSE: ${LICENSE_LABEL[game.license]}`, SCREEN_W / 2, 210, 20, AMBER, 'center');
        text('SOURCE:', SCREEN_W / 2, 260, 16, PHOSPHOR_DIM, 'center');
        text(game.sourceUrl.replace('https://', ''), SCREEN_W / 2, 286, 16, PHOSPHOR_DIM, 'center');
        text(`@ ${game.sourceCommit.slice(0, 12)}`, SCREEN_W / 2, 312, 16, PHOSPHOR_DIM, 'center');
        if (game.bundledSource) {
          text('FULL SOURCE SHIPS WITH THE APP', SCREEN_W / 2, 350, 14, PHOSPHOR_DIM, 'center');
          text('(arcade/source/)', SCREEN_W / 2, 372, 14, PHOSPHOR_DIM, 'center');
        }
      } else {
        text('EMULATOR: JSNES (APACHE-2.0)', SCREEN_W / 2, 130, 18, PHOSPHOR, 'center');
        text('EVERY GAME HERE IS HOMEBREW', SCREEN_W / 2, 190, 16, PHOSPHOR_DIM, 'center');
        text('ITS AUTHOR RELEASED TO SHARE.', SCREEN_W / 2, 214, 16, PHOSPHOR_DIM, 'center');
        text('YOUR OWN CARTRIDGE STAYS ON', SCREEN_W / 2, 264, 16, PHOSPHOR_DIM, 'center');
        text('YOUR DEVICE. NOTHING IS SHARED.', SCREEN_W / 2, 288, 16, PHOSPHOR_DIM, 'center');
        text('FULL LIST: arcade/README.md', SCREEN_W / 2, 338, 16, PHOSPHOR_DIM, 'center');
      }
      text(`◀ ${page + 1}/${CREDIT_PAGES} ▶   ENTER BACK`, SCREEN_W / 2, SCREEN_H - 24, 16, AMBER, 'center');
      finish();
    },

    drawCard(title, line) {
      clear();
      text(title, SCREEN_W / 2, SCREEN_H / 2 - 10, 28, PHOSPHOR, 'center');
      text(line, SCREEN_W / 2, SCREEN_H / 2 + 30, 18, PHOSPHOR_DIM, 'center');
      finish();
    },

    drawAttract() {
      clear();
      text('SSF', SCREEN_W / 2, 170, 72, AMBER, 'center');
      text('ARCADE', SCREEN_W / 2, 240, 52, PHOSPHOR, 'center');
      text(`${ARCADE_GAMES.length} GAMES INSIDE`, SCREEN_W / 2, 310, 20, PHOSPHOR_DIM, 'center');
      text('STEP UP TO PLAY', SCREEN_W / 2, 370, 22, PHOSPHOR, 'center');
      finish();
    },
  };
}
