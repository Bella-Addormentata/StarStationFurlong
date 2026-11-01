/**
 * 🕹️ The arcade cabinet's screen: everything that paints the cabinet's
 * in-world CanvasTexture — the running game, its standby screen (#333: a
 * picture of the game's own title and menu, with a band of what to press),
 * the menu it falls back to, the credits pages and the idle attract card.
 *
 * The canvas is 512×480, exactly twice the NES's 256×240, so each NES pixel is
 * a 2×2 block — or, on the double-wide cabinet, 1024×384, its two tubes' 8:3,
 * where everything here is drawn at 512×480 and stretched to fill it, as
 * the two tubes stretched it before, and a cabinet's own game (drawWith)
 * draws at the canvas's own size. The canvas stays clean apart from blacks lifted off pure
 * black: the CRT look (scanlines, bleed, glow, vignette, flicker) is the
 * tube's own material, drawn over this picture in the cabinet (arcadeCrt.ts,
 * #194).
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

/** The band along the bottom of a standby picture. */
export interface StandbyBand {
  /** The middle: PRESS START, or what is going on (LOADING…). */
  centre: string;
  /** Whether the middle shows now: PRESS START blinks. */
  on: boolean;
  /** Small words at its ends: the tally, the way to the credits. */
  left?: string;
  right?: string;
}

/** The band's height on the 512×480 screen: the bottom 17 NES rows. */
const BAND_H = 34;

/**
 * Paint a game's standby picture (a bundled ROM's title screen, 256×240)
 * over the whole `w`×`h` canvas, stretched as the game is, and its band
 * along the bottom: dark enough to read, clear enough that the game's own
 * bottom lines show through.
 */
export function paintStandby(
  ctx: CanvasRenderingContext2D, w: number, h: number, picture: CanvasImageSource, band: StandbyBand,
): void {
  ctx.save();
  ctx.setTransform(w / SCREEN_W, 0, 0, h / SCREEN_H, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(picture, 0, 0, SCREEN_W, SCREEN_H);
  const top = SCREEN_H - BAND_H;
  ctx.fillStyle = 'rgba(4,10,7,0.74)';
  ctx.fillRect(0, top, SCREEN_W, BAND_H);
  ctx.fillStyle = PHOSPHOR_DIM;
  ctx.fillRect(0, top, SCREEN_W, 2);
  const say = (s: string, x: number, size: number, color: string, align: CanvasTextAlign, max: number) => {
    ctx.font = `bold ${size}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, top + BAND_H / 2 + 1, max);
  };
  if (band.on) say(band.centre, SCREEN_W / 2, 18, AMBER, 'center', SCREEN_W - 200);
  if (band.left) say(band.left, 22, 12, PHOSPHOR_DIM, 'left', 90);
  if (band.right) say(band.right, SCREEN_W - 22, 12, PHOSPHOR_DIM, 'right', 90);
  ctx.restore();
}

export interface ArcadeScreenPainter {
  /** Paint one emulator frame. */
  drawFrame(frame: ArrayLike<number>): void;
  /** The game's standby picture and its band (paintStandby). */
  drawStandby(picture: CanvasImageSource, band: StandbyBand): void;
  /** The game menu: rows, the selected one, an optional status line. The
   *  cabinet shows it where it has no standby picture (yet). */
  drawMenu(rows: ArcadeMenuRow[], selected: number, status: string | null, blink: boolean): void;
  /** One credits page per bundled game (page ≥ games ⇒ the closing page). */
  drawCredits(page: number): void;
  /** A one-line card ("LOADING THWAITE…"). */
  drawCard(title: string, line: string): void;
  /** The idle cabinet: what everyone else in the room sees. */
  drawAttract(): void;
  /** Hand the whole canvas, at its own size, to a cabinet's own game. */
  drawWith(paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void;
}

/** Pages drawCredits can show: one per bundled game plus the closing page. */
export const CREDIT_PAGES = ARCADE_GAMES.length + 1;

export function createArcadeScreenPainter(
  canvas: HTMLCanvasElement,
  size: { w: number; h: number } = { w: SCREEN_W, h: SCREEN_H },
): ArcadeScreenPainter {
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d')!;
  /** Everything but drawWith draws on a 512×480 screen, stretched to the canvas. */
  const fit = () => ctx.setTransform(size.w / SCREEN_W, 0, 0, size.h / SCREEN_H, 0, 0);

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
      fit();
      const s = nesSurface();
      writeFrameRgba(frame, s.image.data);
      s.ctx.putImageData(s.image, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(s.canvas, 0, 0, SCREEN_W, SCREEN_H);
    },

    drawStandby(picture, band) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      paintStandby(ctx, canvas.width, canvas.height, picture, band);
    },

    drawMenu(rows, selected, status, blink) {
      fit();
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
    },

    drawCredits(page) {
      fit();
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
        text('ITS AUTHOR CHOSE TO SHARE.', SCREEN_W / 2, 214, 16, PHOSPHOR_DIM, 'center');
        text('THE OWNER PICKS THE CABINET\'S', SCREEN_W / 2, 264, 16, PHOSPHOR_DIM, 'center');
        text('GAME IN ITS ⚙️ SETTINGS.', SCREEN_W / 2, 288, 16, PHOSPHOR_DIM, 'center');
        text('FULL LIST: arcade/README.md', SCREEN_W / 2, 338, 16, PHOSPHOR_DIM, 'center');
      }
      text(`◀ ${page + 1}/${CREDIT_PAGES} ▶   ENTER BACK`, SCREEN_W / 2, SCREEN_H - 24, 16, AMBER, 'center');
    },

    drawCard(title, line) {
      fit();
      clear();
      text(title, SCREEN_W / 2, SCREEN_H / 2 - 10, 28, PHOSPHOR, 'center');
      text(line, SCREEN_W / 2, SCREEN_H / 2 + 30, 18, PHOSPHOR_DIM, 'center');
    },

    drawAttract() {
      fit();
      clear();
      text('SSF', SCREEN_W / 2, 170, 72, AMBER, 'center');
      text('ARCADE', SCREEN_W / 2, 240, 52, PHOSPHOR, 'center');
      text(`${ARCADE_GAMES.length} GAMES INSIDE`, SCREEN_W / 2, 310, 20, PHOSPHOR_DIM, 'center');
      text('STEP UP TO PLAY', SCREEN_W / 2, 370, 22, PHOSPHOR, 'center');
    },

    drawWith(paint) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      paint(ctx, canvas.width, canvas.height);
    },
  };
}
