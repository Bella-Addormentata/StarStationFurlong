/**
 * 🕹 Each game's sign (#333): the lit marquee above a cabinet's screen,
 * dressed for the game the owner put on it rather than one sign for every
 * cabinet. A bundled ROM's sign carries the game's own logo, cut from its
 * standby picture (arcadeStandby.ts), on glass in the title screen's colours
 * with a little of the game drawn behind it: Thwaite's night sky and its
 * missiles, Concentration Room's cards, NESert Golfing's dunes,
 * robotfindskitten's scattered things that are not kitten. A cabinet's own
 * game (Lantern Road) writes its name under its lanterns. The owner's own
 * game keeps the plain backlit amber sign with its file's name.
 *
 * Pure Canvas2D, no three.js: furniture.ts's arcadeMarquee paints it into
 * the marquee's texture. What is scattered behind the name comes from a
 * generator seeded by the game, so every page paints the same sign.
 */

/** What is drawn on the glass behind the name. */
export type SignMotif = 'backlit' | 'stars' | 'cards' | 'dunes' | 'glyphs' | 'lanterns';

export interface CabinetSign {
  /** The glass's colour at its top and at its bottom. */
  glass: readonly [string, string];
  /** The name's colour, and the glow and outline round it. */
  ink: string;
  glow: string;
  /** The frame round the glass. */
  trim: string;
  motif: SignMotif;
  /** The game's own logo in its standby picture (x, y, w, h in NES pixels).
   *  The rectangle's top-left pixel is the title screen's backdrop: that
   *  colour is cut out, so the logo stands on the sign's glass. */
  logo?: readonly [number, number, number, number];
  /** The name as the game writes it, where there is no logo (else the
   *  cabinet's title). */
  name?: string;
  /** The name's typeface. */
  font?: string;
}

const MONO = "'SF Mono','Consolas',monospace";

/** The sign for anything that isn't one of ours: the owner's own game, or
 *  a cabinet with no game yet. */
export const DEFAULT_SIGN: CabinetSign = {
  glass: ['#3a1606', '#ffb84a'],
  ink: '#fff6e0',
  glow: '#1a0a14',
  trim: '#d4a84b',
  motif: 'backlit',
};

export const ARCADE_SIGNS: Readonly<Record<string, CabinetSign>> = {
  thwaite: {
    glass: ['#02030c', '#101a46'],
    ink: '#ffffff',
    glow: '#ff7a1a',
    trim: '#4a64d8',
    motif: 'stars',
    logo: [63, 76, 122, 29],
  },
  'concentration-room': {
    glass: ['#ffffff', '#e4e8f0'],
    ink: '#101010',
    glow: '#ffffff',
    trim: '#c8303a',
    motif: 'cards',
    logo: [47, 34, 162, 63],
  },
  'nesert-golfing': {
    glass: ['#0a0ab7', '#2436d8'],
    ink: '#ffffff',
    glow: '#0a0a50',
    trim: '#e8d7c6',
    motif: 'dunes',
    logo: [63, 31, 130, 66],
  },
  robotfindskitten: {
    glass: ['#000000', '#0a0a0a'],
    ink: '#ffffff',
    glow: '#3c9f6a',
    trim: '#7cffb0',
    motif: 'glyphs',
    name: 'robotfindskitten',
  },
  'lantern-road': {
    glass: ['#0c0620', '#2a1240'],
    ink: '#ffd36a',
    glow: '#b0201a',
    trim: '#d4a84b',
    motif: 'lanterns',
    name: 'LANTERN ROAD',
    font: "Georgia,'Times New Roman',serif",
  },
};

/** The sign for a cabinet's game (a bundled ROM's or a cabinet's own game's
 *  id), or DEFAULT_SIGN. */
export function signFor(gameId: string | null | undefined): CabinetSign {
  return (gameId && ARCADE_SIGNS[gameId]) || DEFAULT_SIGN;
}

/** A small seeded generator (mulberry32), so a sign's scatter is the same
 *  on every page. */
function seeded(text: string): () => number {
  let a = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 0x01000193);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Thwaite: stars, and missiles streaking down toward the town. */
function paintStars(g: CanvasRenderingContext2D, W: number, H: number, rnd: () => number): void {
  for (let i = 0; i < W / 6; i++) {
    g.fillStyle = rnd() < 0.2 ? '#ffe9a0' : '#c8d4ff';
    const s = rnd() < 0.15 ? 2 : 1;
    g.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H), s, s);
  }
  g.lineWidth = Math.max(1.5, H / 40);
  for (let i = 0; i < 4; i++) {
    const side = i % 2 === 0 ? rnd() * W * 0.22 : W - rnd() * W * 0.22;
    const x0 = side + (rnd() - 0.5) * W * 0.1;
    const x1 = x0 + (i % 2 === 0 ? 1 : -1) * W * (0.03 + rnd() * 0.05);
    const y1 = H * (0.45 + rnd() * 0.4);
    const trail = g.createLinearGradient(x0, 0, x1, y1);
    trail.addColorStop(0, 'rgba(255,255,255,0)');
    trail.addColorStop(1, 'rgba(255,220,180,0.85)');
    g.strokeStyle = trail;
    g.beginPath();
    g.moveTo(x0, 0);
    g.lineTo(x1, y1);
    g.stroke();
    g.fillStyle = '#ff7a1a';
    g.fillRect(x1 - 2, y1 - 2, 4, 4);
  }
}

/** Concentration Room: face-down cards at both ends, one turned up. */
function paintCards(g: CanvasRenderingContext2D, W: number, H: number, rnd: () => number): void {
  const ch = H * 0.62;
  const cw = ch * 0.7;
  const across = Math.max(2, Math.floor((W * 0.16) / (cw * 0.8)));
  for (const end of [0, 1]) {
    for (let i = 0; i < across; i++) {
      const x = end === 0 ? W * 0.03 + i * cw * 0.8 : W * 0.97 - cw - i * cw * 0.8;
      const y = (H - ch) / 2 + (rnd() - 0.5) * H * 0.12;
      const up = end === 1 && i === 0;
      g.fillStyle = up ? '#ffffff' : '#1c2c78';
      g.strokeStyle = '#101010';
      g.lineWidth = Math.max(1, H / 60);
      g.fillRect(x, y, cw, ch);
      g.strokeRect(x, y, cw, ch);
      // The back's diamond, or the turned card's mark.
      g.fillStyle = up ? '#c8303a' : '#f0f0f0';
      g.beginPath();
      g.moveTo(x + cw / 2, y + ch * 0.22);
      g.lineTo(x + cw * 0.78, y + ch / 2);
      g.lineTo(x + cw / 2, y + ch * 0.78);
      g.lineTo(x + cw * 0.22, y + ch / 2);
      g.closePath();
      g.fill();
    }
  }
}

/** NESert Golfing: dunes along the bottom, a flag on the right. */
function paintDunes(g: CanvasRenderingContext2D, W: number, H: number, rnd: () => number): void {
  g.fillStyle = '#e8d7c6';
  g.beginPath();
  g.moveTo(0, H);
  let y = H * 0.82;
  for (let x = 0; x <= W; x += W / 16) {
    y = Math.min(H * 0.9, Math.max(H * 0.62, y + (rnd() - 0.5) * H * 0.18));
    g.lineTo(x, y);
  }
  g.lineTo(W, H);
  g.closePath();
  g.fill();
  const fx = W * 0.9;
  g.fillStyle = '#ffffff';
  g.fillRect(fx, H * 0.38, Math.max(1, H / 50), H * 0.34);
  g.beginPath();
  g.moveTo(fx, H * 0.38);
  g.lineTo(fx + H * 0.16, H * 0.45);
  g.lineTo(fx, H * 0.52);
  g.closePath();
  g.fill();
  g.fillStyle = '#ff6a2a';
  g.fillRect(W * 0.08, H * 0.68, Math.max(2, H / 20), Math.max(2, H / 20));
}

/** robotfindskitten: things that are not kitten, everywhere. */
function paintGlyphs(g: CanvasRenderingContext2D, W: number, H: number, rnd: () => number): void {
  const glyphs = '!"$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  const colours = ['#ff5f5f', '#5fff8f', '#5fafff', '#ffd75f', '#ff87ff', '#5fffff', '#ffffff'];
  const size = Math.max(8, Math.round(H * 0.2));
  g.font = `bold ${size}px ${MONO}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < W / 14; i++) {
    g.fillStyle = colours[Math.floor(rnd() * colours.length)]!;
    g.fillText(glyphs[Math.floor(rnd() * glyphs.length)]!, rnd() * W, rnd() * H);
  }
  // A quiet strip for the name to stand on.
  g.fillStyle = 'rgba(0,0,0,0.82)';
  g.fillRect(W * 0.12, H * 0.22, W * 0.76, H * 0.56);
}

/** Lantern Road: paper lanterns on a string across the top. */
function paintLanterns(g: CanvasRenderingContext2D, W: number, H: number): void {
  const sag = H * 0.16;
  const at = (x: number) => H * 0.08 + sag * 4 * (x / W) * (1 - x / W);
  g.strokeStyle = '#3a2a1a';
  g.lineWidth = Math.max(1, H / 60);
  g.beginPath();
  for (let x = 0; x <= W; x += W / 32) (x === 0 ? g.moveTo(x, at(x)) : g.lineTo(x, at(x)));
  g.stroke();
  const n = Math.max(4, Math.round(W / (H * 0.9)));
  for (let i = 0; i < n; i++) {
    const x = ((i + 0.5) / n) * W;
    // Leave the middle to the name.
    if (Math.abs(x - W / 2) < W * 0.27) continue;
    const top = at(x);
    const lw = H * 0.24;
    const lh = H * 0.36;
    const body = g.createLinearGradient(x - lw / 2, 0, x + lw / 2, 0);
    body.addColorStop(0, '#7a1010');
    body.addColorStop(0.5, '#ff6a3a');
    body.addColorStop(1, '#7a1010');
    g.fillStyle = body;
    g.beginPath();
    g.ellipse(x, top + H * 0.06 + lh / 2, lw / 2, lh / 2, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#20140a';
    g.fillRect(x - lw * 0.3, top + H * 0.04, lw * 0.6, H * 0.04);
    g.fillRect(x - lw * 0.3, top + H * 0.04 + lh, lw * 0.6, H * 0.04);
  }
}

/**
 * Paint `sign` onto a `W`×`H` marquee: its glass and what is on it, then the
 * game's logo (`logo`, already cut out: arcadeStandby.standbyLogo) or, with
 * none, its name — `sign.name`, else `title` — fitted to the glass.
 */
export function paintSign(
  g: CanvasRenderingContext2D, W: number, H: number, title: string, sign: CabinetSign, logo: CanvasImageSource | null,
  seed = title,
): void {
  const rnd = seeded(seed);
  if (sign.motif === 'backlit') {
    // Backlit glass: warm at the centre, darker at the ends.
    const glass = g.createLinearGradient(0, 0, W, 0);
    glass.addColorStop(0, sign.glass[0]);
    glass.addColorStop(0.5, sign.glass[1]);
    glass.addColorStop(1, sign.glass[0]);
    g.fillStyle = glass;
  } else {
    const glass = g.createLinearGradient(0, 0, 0, H);
    glass.addColorStop(0, sign.glass[0]);
    glass.addColorStop(1, sign.glass[1]);
    g.fillStyle = glass;
  }
  g.fillRect(0, 0, W, H);
  if (sign.motif === 'stars') paintStars(g, W, H, rnd);
  else if (sign.motif === 'cards') paintCards(g, W, H, rnd);
  else if (sign.motif === 'dunes') paintDunes(g, W, H, rnd);
  else if (sign.motif === 'glyphs') paintGlyphs(g, W, H, rnd);
  else if (sign.motif === 'lanterns') paintLanterns(g, W, H);
  // A sheen down from the top of the glass.
  const sheen = g.createLinearGradient(0, 0, 0, H * 0.35);
  sheen.addColorStop(0, 'rgba(255,240,200,0.16)');
  sheen.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = sheen;
  g.fillRect(0, 0, W, H * 0.35);

  if (logo && sign.logo) {
    const [, , lw, lh] = sign.logo;
    const scale = Math.min((H * 0.8) / lh, (W * 0.72) / lw);
    const dw = lw * scale;
    const dh = lh * scale;
    g.imageSmoothingEnabled = false;
    g.shadowColor = sign.glow;
    g.shadowBlur = H * 0.12;
    g.drawImage(logo, (W - dw) / 2, (H - dh) / 2, dw, dh);
    g.shadowBlur = 0;
    g.imageSmoothingEnabled = true;
  } else {
    const raw = sign.name ?? title;
    const name = raw.length > 22 ? `${raw.slice(0, 21)}…` : raw;
    const font = sign.font ?? MONO;
    let size = Math.round(H * 0.62);
    g.font = `900 ${size}px ${font}`;
    while (size > 12 && g.measureText(name).width > W * 0.72) {
      size -= 2;
      g.font = `900 ${size}px ${font}`;
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = Math.max(2, size / 12);
    g.strokeStyle = sign.glow;
    g.shadowColor = sign.glow;
    g.shadowBlur = H * 0.1;
    g.strokeText(name, W / 2, H / 2 + 3, W - 30);
    g.shadowBlur = 0;
    g.fillStyle = sign.ink;
    g.fillText(name, W / 2, H / 2 + 3, W - 30);
  }
  g.strokeStyle = sign.trim;
  g.lineWidth = 6;
  g.strokeRect(3, 3, W - 6, H - 6);
}
