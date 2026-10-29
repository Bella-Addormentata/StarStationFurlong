/**
 * 🧪🎲🌐 Computed craps over the simulated network, the design's last
 * scenarios: who shoots ("shooter"), stands changed late ("stand-change"), a
 * throw that lands after another page's close on clocks up to 3 s apart
 * ("throw-after-close"), and a roll shown and then rewritten (the status
 * words no other scenario holds to the design). Every page has the real table
 * UI mounted (computedCrapsUiKit) and its table's pieces driven every frame
 * (casinoTablesFrame over a fake dice handle), so what each page says (its
 * status line, its notices, its ⚙ card) and the dice it flies are held to the
 * design as well as the fold. A director plays each scenario: it rigs each
 * roll's dice through the pages' seed queues (computedPageKit rigRoll), puts
 * the bets down through the felt's own writer, moves players between stands,
 * the device front and off the table, and acts at an exact page time when a
 * case needs it (0.2 s before the wait ends). Each scenario runs three seeds
 * through the shared finish (computedCrapsSimKit) and asserts what the design
 * says, with counters that prove every case happened on every seed.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { between, Sim } from './computedSim';
import type { PageSpec, SimPage, SimSummary } from './computedSim';
import { canonList, CRAPS_BOT } from './computedCrapsSim';
import type { CrapsBotSpec, Place } from './computedCrapsSim';
import { T, TIMEOUT, finish, seed } from './computedCrapsSimKit';
import type { Finish } from './computedCrapsSimKit';
import { atCraps, stubDom, withUI } from './computedCrapsUiKit';
import type { AtCraps, FakeEl, UIPage } from './computedCrapsUiKit';
import { putIn, rigRoll, rigSplit, signAs } from './computedPageKit';
import type { Page } from './computedPageKit';
import type { CloseRec, CrapsSlipRec, ForfeitRec, RoundView } from './computedFold';
import type { CrapsCarry } from './computedCraps';
import type { ComputedCrapsState } from './computedTable';
import type { CrapsBet } from './games/craps';
import { escapeHtml } from './htmlEscape';

vi.stubGlobal('window', { location: { search: '' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SEEDS = [1, 2, 3];
const lines: string[] = [];
const timings: string[] = [];
const crapsTable = [{ id: T, game: 'craps' as const }];

afterAll(() => {
  if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
  if (timings.length > 0) console.log(`\n[timing]\n${timings.join('\n')}`);
});

// ── 🖥️ The table UI on every page ────────────────────────────────────────────

/** A DOM whose timers do nothing: the director drives the UI by hand (its
 *  seat beat is the harness's, sit). */
function uiDom(): void {
  stubDom({ setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} });
}
/** The globals as the file has them (a scenario done). */
function noDom(): void {
  vi.unstubAllGlobals();
  vi.stubGlobal('window', { location: { search: '' } });
}

/** Each load of a page: the table UI's modules (its own generation), and the
 *  games doc bound to its room doc, as main.ts binds it: the players' names
 *  the status line and the ⚙ card show come from the room's players map. */
const loadUI = async (p: Page): Promise<void> => {
  await withUI(p);
  const games = await import('./games/gamesDoc');
  games.bindGamesDoc(p.doc);
};

/** A player name that is markup: every line naming its player must show it
 *  as text (textContent) and the ⚙ card escaped (innerHTML). */
const MARKUP = '<i onmouseover="go()">Ann & "Bo"</i>';
const MARKUP_UP = MARKUP.toUpperCase();
const MARKUP_ESC = escapeHtml(MARKUP_UP);
/** Markup escaped into text: a line that shows `&LT;` shows the wrong name. */
const ENTITY = /&(lt|gt|amp|quot|#\d+);/i;

const POINTS = [4, 5, 6, 8, 9, 10];
const NON7 = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
/** A fling drawn past the 20 s wait: the bot never throws it. */
const FAR = 40_000;
const FLICK = [{ x: 0, z: 0.3 }, { x: 0, z: 0.1 }, { x: 0, z: -0.1 }, { x: 0, z: -0.3 }];
const ptr = (): Record<string, unknown> => ({
  button: 0, pointerType: 'mouse', pointerId: 1, clientX: 500, clientY: 400, stopPropagation() {}, preventDefault() {},
});

/** The scripted player: no moves, tries, stand moves or fakes of its own,
 *  and no throw of its own: the shooter throws through the mounted table UI
 *  (the director's), as a player does, so what the UI says of the offer is
 *  what its own fling did (a throw made around the UI leaves its offer open:
 *  TIME'S UP once the roll shows). */
const bot = (): CrapsBotSpec => ({
  ...CRAPS_BOT, move: 0, tries: 0, standMove: 0, fake: 0, lateEvery: 0, fling: [FAR, FAR], low: 0,
});
const pageAt = (name: string, place: Place, extra: Partial<PageSpec> = {}): PageSpec => ({ name, place, crapsBot: bot(), onLoad: loadUI, ...extra });

const pick = <X>(r: () => number, xs: readonly X[]): X => xs[Math.floor(r() * xs.length)];
/** A sum that keeps the hand going: a point on a come-out, else anything but
 *  a seven or the point. */
const keepSum = (r: () => number, p: number): number => (p === 0 ? pick(r, POINTS) : pick(r, NON7.filter((s) => s !== p)));
const tossOf = (hash: string): number => parseInt(hash.slice(0, 8), 16) % 2 ** 31;
const seedOf = (entry: string): number | null => {
  const m = /^throw (\d+)$/.exec(entry);
  return m ? Number(m[1]) : null;
};
const subOf = (el: FakeEl): FakeEl[] => [...(el as unknown as { sub: Map<string, FakeEl> }).sub.values()];
const riding = (K: CrapsCarry, pid: string): boolean => (K.w[pid] ?? []).length > 0;

interface Mounted {
  t: AtCraps;
  stand: number | null;
  capture: FakeEl;
  status: FakeEl;
  live: FakeEl;
  /** Every element this mount made (the bar, the capture, the ⚙ card). */
  els: FakeEl[];
  statusAt: number;
  liveAt: number;
}

/** A status line or notice a page showed, with the roll and phase its view
 *  read in the frame that collected it. */
interface Said { page: string; T: number; r: number; phase: string; kind: 'line' | 'notice'; text: string }
/** What a page's dice were asked to do (`throw <seed>`, `land dd`, `cancel`),
 *  with the roll its view read and the stickman's toss of the close it held. */
interface Flew { page: string; T: number; r: number; phase: string; entry: string; toss: number | null }
/** A decided roll as the room's fold has it (its last version). */
interface RollRec {
  r: number;
  close: string;
  decided: string;
  counted: string[];
  dice: [number, number] | null;
  sum: number;
  sIn: CrapsCarry;
  sOut: CrapsCarry;
  pointBefore: number | null;
  pointAfter: number | null;
  sevenOut: boolean;
  /** The frozen slips, by pid; who was seated (counted, at a stand, with
   *  chips) and where. */
  slips: Map<string, CrapsSlipRec>;
  seated: Map<string, number>;
  T: number;
}
interface CloseSeen { hash: string; by: string; T: number; at: number | null; atT: number | null }

// ── 🎬 The stage: the UIs, what they show, what the room did ─────────────────

class Stage {
  readonly ui = new Map<SimPage, Mounted>();
  readonly said: Said[] = [];
  readonly flew: Flew[] = [];
  readonly rolls = new Map<number, RollRec>();
  /** Every version of a decided roll the room's fold showed (rewrites). */
  readonly versions: RollRec[] = [];
  readonly closes = new Map<number, Map<string, CloseSeen>>();
  /** `<page>|<roll>`: the end of betting (W) and of the wait (D), page clock. */
  readonly waits = new Map<string, { W?: number; D?: number }>();
  /** `<page>|<roll>`: the seed of the page's own fling. */
  readonly flung = new Map<string, number>();
  /** Throw records the room read (any page's), in order. */
  readonly throws: { T: number; round: number; by: string; seed: number }[] = [];
  readonly problems: string[] = [];
  /** A case's own word before a page's frame (false: no frame, a lag). */
  readonly pre = new Map<SimPage, (now: number) => boolean>();
  /** Lines and notices naming the markup player, on other pages; ⚙ cards
   *  checked with it in them. */
  named = 0;
  cards = 0;
  /** With the notice oracle on: notices the screens' changes called for. */
  rewritten = 0;
  changed = 0;
  noticeOracle = false;
  /** The craps table's player stands in the ring's order (ascending angle). */
  readonly order: number[];
  /** The wait for the throw (CRAPS_SHOOTER_MS). */
  readonly SHOOTER_MS: number;
  private making: FakeEl[] | null = null;
  private readonly logAt = new Map<SimPage, number>();
  private readonly last = new Map<SimPage, string>();
  private readonly shown = new Map<SimPage, { pockets: Map<number, string>; keys: Map<number, string> }>();
  private acts: { sp: SimPage; at: number; fn: (now: number) => void }[] = [];
  private lastThrow = '';
  private readonly bad = new Set<string>();

  private constructor(readonly sim: Sim, readonly markup: SimPage | null, stands: { n: number; x: number; z: number; player: boolean }[]) {
    this.order = stands.filter((s) => s.player && s.n >= 1 && s.n <= 7).sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x)).map((s) => s.n);
    this.SHOOTER_MS = sim.pages[0].p.croupier.CRAPS_SHOOTER_MS;
  }

  /** The stage over sim's pages: `markup`'s player named in markup, every
   *  page's UI mounted where its player is, its frames driving the table. */
  static async open(sim: Sim, markup: SimPage | null): Promise<Stage> {
    const { FURNITURE_DEFS } = await import('./furniture');
    const defs = FURNITURE_DEFS['craps-table'].stands ?? [];
    const stage = new Stage(sim, markup, defs.map((s, n) => ({ n, x: s.stand.x, z: s.stand.z, player: !s.role })));
    const doc = (globalThis as unknown as { document: { createElement: (tag: string) => FakeEl } }).document;
    const make = doc.createElement;
    doc.createElement = (tag: string): FakeEl => {
      const el = make(tag);
      stage.making?.push(el);
      return el;
    };
    if (markup) {
      await sim.as(markup, () => markup.p.doc.transact(() => markup.p.doc.getMap('players').set(markup.pid, { keyB64: markup.p.pub, name: MARKUP })));
      await sim.syncAll();
    }
    for (const sp of sim.pages) {
      sim.enter(sp);
      stage.mount(sp);
      sp.beforeFrame = (now) => stage.frame(sp, now);
      // (The robot's hold reads the felt's dice, as World's does.)
      sp.robotMotion = () => {
        const st = (sp.p as UIPage).dice.state();
        return { moving: st === 'flying' || st === 'settling', drawn: true };
      };
    }
    return stage;
  }

  /** Who a status line names for pid. */
  name(pid: string): string {
    return pid === this.markup?.pid ? MARKUP_UP : pid.toUpperCase();
  }

  // ── The UIs ──

  /** Page sp's UI mounted where its player is (none off the table); the
   *  caller has entered the page. */
  mount(sp: SimPage): void {
    const place = this.sim.craps!.placeOf(sp, T);
    if (place === 'off' || this.ui.has(sp)) return;
    const els: FakeEl[] = [];
    this.making = els;
    const t = atCraps(sp.p as UIPage, { stand: place, table: T });
    this.making = null;
    const bar = els.find((e) => e.id === 'casino-table-bar')!;
    const capture = els.find((e) => e.id === 'casino-table-capture')!;
    this.ui.set(sp, { t, stand: place, capture, status: bar.querySelector('[data-status]'), live: bar.querySelector('[data-live]'), els, statusAt: 0, liveAt: 0 });
  }

  unmount(sp: SimPage): void {
    const m = this.ui.get(sp);
    if (!m) return;
    m.t.unmount();
    this.ui.delete(sp);
  }

  /** Page sp's player goes to `to` (its UI with it), at the page's clock now. */
  move(sp: SimPage, to: Place, now: number): void {
    this.unmount(sp);
    this.sim.craps!.moveTo(sp, T, to, now);
    this.mount(sp);
  }

  /** A key on page sp's mounted UI. */
  key(sp: SimPage, k: string): void {
    const m = this.ui.get(sp);
    if (!m) return;
    this.making = m.els;
    m.t.key(k);
    this.making = null;
  }

  /** The shooter's throw through page sp's mounted UI (its key, or a flick
   *  of the dice across the felt), its tumble drawn from the page's own
   *  draws; the harness counts it as the page's own fling. Whether it threw. */
  throwVia(sp: SimPage, how: 'key' | 'flick'): boolean {
    const m = this.ui.get(sp);
    if (!m) return false;
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => sp.rand());
    try {
      return this.sim.craps!.uiFling(sp, T, () => {
        this.making = m.els;
        if (how === 'key') m.t.key('r');
        else m.t.fling(FLICK, 20);
        this.making = null;
      });
    } finally {
      spy.mockRestore();
    }
  }

  /** The dice picked up on page sp's felt and held (the pointer stays down). */
  grab(sp: SimPage): void {
    const m = this.ui.get(sp);
    if (!m) return;
    const p = sp.p as UIPage;
    p.dice.aim.dice = true;
    p.dice.aim.p = { x: 0, z: 0.3 };
    m.capture.fire('pointerdown', ptr());
    p.dice.aim.dice = false;
    p.dice.aim.p = null;
  }

  letGo(sp: SimPage): void {
    this.ui.get(sp)?.capture.fire('pointerup', ptr());
  }

  /** The ⚙ card's markup on page sp, opened and closed again. */
  card(sp: SimPage): string {
    const m = this.ui.get(sp);
    if (!m) return '';
    this.making = m.els;
    const html = m.t.card();
    m.t.key('s');
    this.making = null;
    return html;
  }

  /** Run `fn` as page sp at exactly `at` on its clock: on the first tick whose
   *  frame comes at or after it, before that tick's deliveries and frames
   *  (its last frame came before `at`). */
  precise(sp: SimPage, at: number, fn: (now: number) => void): void {
    this.acts.push({ sp, at, fn });
  }

  // ── Each frame of a page ──

  /** Page sp's frame (its beforeFrame): the case's word first, then World's
   *  frame of its tables' pieces and its mounted UI's update; what the dice
   *  were asked to do, and what the UI shows, collected. */
  frame(sp: SimPage, now: number): boolean {
    const go = this.pre.get(sp)?.(now) ?? true;
    if (!go) return false;
    const p = sp.p as UIPage;
    const m = this.ui.get(sp);
    this.making = m?.els ?? null;
    p.session.casinoTablesFrame(1 / 60, new Map([[T, p.dice.h]]));
    m?.t.update();
    this.making = null;
    const v = p.table.readComputedCraps(T, now);
    const r = v?.round ?? 0;
    const phase = v?.phase ?? '-';
    const log = p.dice.log;
    for (let i = this.logAt.get(sp) ?? 0; i < log.length; i++) {
      const close = log[i].startsWith('throw ') ? p.table.computedCrapsClose(T, r) : null;
      this.flew.push({ page: sp.name, T: this.sim.elapsed, r, phase, entry: log[i], toss: close ? tossOf(close.hash) : null });
    }
    this.logAt.set(sp, log.length);
    // (Through a roll's result its dice are down, never still in the air
    // with no faces: checkFlights's count of flights and its last landing
    // can't see that.)
    if (phase === 'settled' && v?.rollKey.startsWith(`${r}:`) && p.dice.state() === 'flying') {
      this.problem(`aloft|${sp.name}|${r}`, `${sp.name}'s dice were in the air at ${this.sim.elapsed} ms through roll ${r}'s result: ${JSON.stringify(this.flew.filter((f) => f.page === sp.name && f.r >= r - 1 && f.r <= r).map((f) => `${f.T} ${f.r} ${f.phase} ${f.entry}`))}`);
    }
    if (m) {
      const fresh = this.collect(sp, m, r, phase);
      if (this.noticeOracle && v) this.notices(sp, v, fresh);
    }
    return true;
  }

  /** The lines and notices page sp's UI showed since its last frame (a line
   *  once while it stands), checked: markup in a name stays text. The new
   *  notices. */
  private collect(sp: SimPage, m: Mounted, r: number, phase: string): string[] {
    for (; m.statusAt < m.status.texts.length; m.statusAt++) {
      const text = m.status.texts[m.statusAt];
      if (text === this.last.get(sp)) continue;
      this.last.set(sp, text);
      this.note(sp, 'line', text, r, phase);
    }
    const fresh: string[] = [];
    for (; m.liveAt < m.live.texts.length; m.liveAt++) {
      const text = m.live.texts[m.liveAt].replace(/​/g, '');
      if (text === '') continue;
      fresh.push(text);
      this.note(sp, 'notice', text, r, phase);
    }
    // No element's markup carries the name as markup: the lines go in as
    // text (textContent), the ⚙ card's names escaped.
    if (this.markup) {
      for (const el of [...m.els, ...m.els.flatMap(subOf)]) {
        if (!el.innerHTML.includes(MARKUP_UP) && !el.innerHTML.includes(MARKUP)) continue;
        this.problem(`raw|${sp.name}|${el.id}`, `${sp.name}'s UI put the player name into markup unescaped (element ${el.id || '?'}) at ${this.sim.elapsed} ms: ${el.innerHTML.slice(0, 200)}`);
      }
    }
    return fresh;
  }

  private note(sp: SimPage, kind: 'line' | 'notice', text: string, r: number, phase: string): void {
    this.said.push({ page: sp.name, T: this.sim.elapsed, r, phase, kind, text });
    if (this.markup && sp !== this.markup && text.includes(MARKUP_UP)) this.named += 1;
    if (ENTITY.test(text)) this.problem(`entity|${sp.name}|${text}`, `${sp.name}'s ${kind} at ${this.sim.elapsed} ms shows markup escaped as text: ${JSON.stringify(text)}`);
  }

  private problem(key: string, what: string): void {
    if (this.bad.has(key)) return;
    this.bad.add(key);
    this.problems.push(what);
  }

  /** The notice oracle on page sp (a frame): the roll on screen showing other
   *  dice than it showed calls for `ROLL n WAS REWRITTEN — NEW DICE`; an
   *  earlier roll that came to something else (its dice, what it handed on,
   *  what it paid), the lowest of them, for `ROLL n CHANGED — …`; and no such
   *  notice comes without one. */
  private notices(sp: SimPage, v: ComputedCrapsState, fresh: string[]): void {
    let s = this.shown.get(sp);
    if (!s) this.shown.set(sp, s = { pockets: new Map(), keys: new Map() });
    const want: { re: RegExp; what: string; kind: 'rewritten' | 'changed' }[] = [];
    const k = /^(\d+):(\d\d)$/.exec(v.rollKey);
    if (k) {
      const r = Number(k[1]);
      const was = s.pockets.get(r);
      if (was !== undefined && was !== k[2]) want.push({ re: new RegExp(`^ROLL ${r} WAS REWRITTEN — NEW DICE$`), what: `ROLL ${r} WAS REWRITTEN (${was} → ${k[2]})`, kind: 'rewritten' });
      s.pockets.set(r, k[2]);
    }
    const res = sp.p.casino.computedFoldOf(T);
    if (res) {
      let D = 0;
      for (const rv of res.rounds) if (rv.decided && rv.craps) D = rv.r;
      let first: number | null = null;
      for (const rv of res.rounds) {
        if (!rv.decided || !rv.craps) continue;
        const key = rollKeyOf(rv);
        const was = s.keys.get(rv.r);
        s.keys.set(rv.r, key);
        if (was !== undefined && was !== key && first === null && rv.r < D) first = rv.r;
      }
      if (first !== null) {
        want.push({
          re: new RegExp(`^ROLL ${first} CHANGED — (THE ROLLS AFTER IT PAID AGAIN ON THE SAME DICE|YOUR BETS ON ROLLS? \\d+(–\\d+)? CAME BACK)$`),
          what: `ROLL ${first} CHANGED`, kind: 'changed',
        });
      }
    }
    const got = fresh.filter((t) => /^ROLL \d+ (WAS REWRITTEN|CHANGED)/.test(t));
    for (const w of want) {
      const i = got.findIndex((t) => w.re.test(t));
      if (i < 0) {
        this.problem(`missing|${sp.name}|${this.sim.elapsed}|${w.what}`, `${sp.name} showed ${w.what} at ${this.sim.elapsed} ms with no such notice (heard ${JSON.stringify(fresh)})`);
        continue;
      }
      got.splice(i, 1);
      if (w.kind === 'rewritten') this.rewritten += 1;
      else this.changed += 1;
    }
    for (const t of got) this.problem(`spurious|${sp.name}|${this.sim.elapsed}|${t}`, `${sp.name} said ${JSON.stringify(t)} at ${this.sim.elapsed} ms with no roll on its screen changed`);
  }

  // ── Each tick: the exact-time acts, then what the room did ──

  tick(): void {
    for (const a of [...this.acts]) {
      if (a.sp.mode !== 'up' || this.sim.T < a.sp.pauseUntil || this.sim.T + a.sp.p.skew < a.at) continue;
      this.acts.splice(this.acts.indexOf(a), 1);
      this.sim.enter(a.sp);
      vi.setSystemTime(a.at);
      a.fn(a.at);
    }
    this.record();
  }

  /** A page that reads the room as it is (up, framing, honest). */
  ref(): SimPage | null {
    return this.sim.pages.find((q) => q.mode === 'up' && this.sim.T >= q.pauseUntil && !q.cheats) ?? null;
  }

  private record(): void {
    const ref = this.ref();
    if (!ref) return;
    this.sim.enter(ref);
    const res = ref.p.casino.computedFoldOf(T);
    const ses = ref.p.casino.computedSessionForWrite(T);
    if (res && ses) {
      for (const v of res.rounds) {
        if (!v.decided || !v.craps) continue;
        const was = this.rolls.get(v.r);
        const dice = v.craps.dice;
        if (was && was.close === v.close && was.decided === v.decided && JSON.stringify(was.dice) === JSON.stringify(dice)
          && JSON.stringify(was.sOut) === JSON.stringify(v.craps.sOut)) continue;
        const slips = new Map<string, CrapsSlipRec>();
        for (const pid of v.present) {
          const s = ses.get(`s:${v.r}:${pid}:${v.frozen[pid]}`) as CrapsSlipRec | undefined;
          if (s) slips.set(pid, s);
          else if (was?.slips.has(pid)) slips.set(pid, was.slips.get(pid)!);
        }
        // Counted at their stand: a stand on the slip and a bet down there,
        // the bets that played (a felt built on a table that has since
        // changed, or one the rules refuse, plays as the bets riding).
        const seated = new Map<string, number>();
        for (const pid of v.counted) {
          const s = slips.get(pid);
          const B = v.craps.fates.get(pid) === 'ok' ? s?.b ?? [] : v.craps.sIn.w[pid] ?? [];
          if (s?.t !== undefined && B.reduce((n, b) => n + b.amount, 0) > 0 && pid.length <= 128) seated.set(pid, s.t);
        }
        const rec: RollRec = {
          r: v.r, close: v.close, decided: v.decided, counted: [...v.counted], dice: dice ? [dice[0], dice[1]] : null, sum: dice ? dice[0] + dice[1] : 0,
          sIn: v.craps.sIn, sOut: v.craps.sOut, pointBefore: v.craps.pointBefore, pointAfter: v.craps.pointAfter, sevenOut: v.craps.sevenOut,
          slips, seated, T: this.sim.elapsed,
        };
        this.rolls.set(v.r, rec);
        this.versions.push(rec);
      }
      for (const key of ses.keys()) {
        if (!key.startsWith('c:')) continue;
        const [, rs, hash] = key.split(':');
        const r = Number(rs);
        let m = this.closes.get(r);
        if (!m) this.closes.set(r, m = new Map());
        if (m.has(hash)) continue;
        const rec = ses.get(key) as CloseRec;
        const by = this.sim.pages.find((q) => q.p.pub === rec.k);
        const at = by ? by.p.casino.computedSeenAt(T, key) ?? null : null;
        m.set(hash, { hash, by: by?.name ?? '?', T: this.sim.elapsed, at, atT: at !== null && by ? at - by.p.skew : null });
      }
      const thr = ref.p.casino.readDiceThrow(T);
      if (thr) {
        const key = `${thr.round}|${thr.by}|${thr.seed}`;
        if (key !== this.lastThrow) {
          this.lastThrow = key;
          this.throws.push({ T: this.sim.elapsed, round: thr.round, by: thr.by, seed: thr.seed });
        }
      }
    }
    for (const sp of this.sim.pages) {
      if (sp.mode !== 'up') continue;
      const now = this.sim.enter(sp);
      const v = sp.p.table.readComputedCraps(T, now);
      if (v && v.phaseDeadline !== undefined && (v.phase === 'betting' || v.phase === 'closing')) {
        const k = `${sp.name}|${v.round}`;
        const w = this.waits.get(k) ?? {};
        if (v.phase === 'betting') w.W = v.phaseDeadline;
        else w.D = v.phaseDeadline;
        this.waits.set(k, w);
      }
      const f = sp.p.table.computedFlungFor(T, now);
      if (f && !this.flung.has(`${sp.name}|${f.r}`)) this.flung.set(`${sp.name}|${f.r}`, f.seed);
    }
  }

  // ── Reading it back ──

  lines(sp: SimPage, r: number, kind: 'line' | 'notice' = 'line'): string[] {
    return this.said.filter((s) => s.page === sp.name && s.r === r && s.kind === kind).map((s) => s.text);
  }
  notice(sp: SimPage): string[] {
    return this.said.filter((s) => s.page === sp.name && s.kind === 'notice').map((s) => s.text);
  }
  throwsOf(sp: SimPage, r: number): Flew[] {
    return this.flew.filter((f) => f.page === sp.name && f.r === r && f.entry.startsWith('throw '));
  }
  landOf(sp: SimPage, r: number): string | null {
    const l = this.flew.filter((f) => f.page === sp.name && f.r === r && f.entry.startsWith('land '));
    return l.length ? l[l.length - 1].entry : null;
  }
  closesOf(r: number): CloseSeen[] {
    return [...(this.closes.get(r)?.values() ?? [])];
  }
  /** The roll's first close in room time (its writer's clock, less its skew). */
  firstClose(r: number): CloseSeen | null {
    let best: CloseSeen | null = null;
    for (const c of this.closesOf(r)) if (c.atT !== null && (!best || c.atT < best.atT!)) best = c;
    return best;
  }
  D(sp: SimPage, r: number): number | undefined {
    return this.waits.get(`${sp.name}|${r}`)?.D;
  }

  /** Who holds the dice after roll `rec`, by the design's rules ("Who
   *  shoots"): the holder passes them on a seven-out, when nobody holds
   *  them, and when not seated on a come-out or on the roll that makes the
   *  point; then to the next seated player round the ring after the last
   *  holder (from the ring's start when that player isn't seated), a lone
   *  shooter back to themself. In play when seated. */
  expected(rec: RollRec): { h?: string; i?: 1 } {
    const ring = [...rec.seated].sort(([a, sa], [b, sb]) => this.order.indexOf(sa) - this.order.indexOf(sb) || (a < b ? -1 : 1)).map(([pid]) => pid);
    const hIn = rec.sIn.h;
    const pass = rec.sevenOut || hIn === undefined || (!rec.seated.has(hIn) && (rec.pointBefore === null || rec.pointAfter === null));
    let h: string | undefined = hIn;
    if (pass) {
      const old = hIn ?? rec.sIn.a;
      const at = old === undefined ? -1 : ring.indexOf(old);
      h = ring.length === 0 ? undefined : ring[(at + 1) % ring.length];
    }
    return h !== undefined && rec.seated.has(h) ? { h, i: 1 } : h !== undefined ? { h } : {};
  }

  /** Every decided roll's holder after it against the design's rules, and
   *  the result line on every page that showed it naming the change of
   *  hands. How many passes of the dice there were (the stickman's first
   *  hand-off counted). */
  checkHolders(skip: (sp: SimPage, r: number) => boolean = () => false): number {
    let passes = 0;
    for (const rec of this.rolls.values()) {
      if (!rec.dice) continue;
      const want = this.expected(rec);
      if (rec.sOut.h !== want.h || rec.sOut.i !== want.i) {
        this.problems.push(`roll ${rec.r} handed the dice to ${rec.sOut.h ?? 'the stickman'} (in play ${rec.sOut.i ?? 0}), the ring says ${want.h ?? 'the stickman'} (${want.i ?? 0}): `
          + `seated ${JSON.stringify([...rec.seated])}, held by ${rec.sIn.h ?? '-'} (last ${rec.sIn.a ?? '-'}), point ${rec.pointBefore} → ${rec.pointAfter}${rec.sevenOut ? ', seven-out' : ''}`);
      }
      const after = rec.sOut.h;
      const back = rec.sevenOut && after !== undefined && after === rec.sIn.h;
      if (after !== rec.sIn.h && after !== undefined) passes += 1;
      if (after === undefined || (after === rec.sIn.h && !back)) continue;
      for (const sp of this.sim.pages) {
        if (skip(sp, rec.r)) continue;
        const shown = this.lines(sp, rec.r).filter((t) => t.startsWith('● '));
        if (shown.length === 0) continue;
        const tail = back && sp.pid === after ? 'THE DICE COME BACK TO YOU' : sp.pid === after ? 'THE DICE PASS TO YOU' : back ? null : `THE DICE PASS TO ${this.name(after)}`;
        if (tail === null) continue;
        const off = shown.filter((t) => !t.includes(tail));
        if (off.length > 0) this.problems.push(`${sp.name}'s result line for roll ${rec.r} doesn't say ${JSON.stringify(tail)}: ${JSON.stringify(off)}`);
      }
    }
    return passes;
  }

  /** One flight of the dice a roll on every page (more only for a rewrite,
   *  `extra`), and the dice coming to rest on the roll's faces (and down
   *  through its result: frame). */
  checkFlights(extra: (sp: SimPage, r: number) => number = () => 0): void {
    for (const rec of this.rolls.values()) {
      if (!rec.dice) continue;
      for (const sp of this.sim.pages) {
        const n = this.throwsOf(sp, rec.r).length;
        if (n > 1 + extra(sp, rec.r)) {
          this.problems.push(`${sp.name} flew the dice ${n} times for roll ${rec.r}: ${JSON.stringify(this.flew.filter((f) => f.page === sp.name && f.r >= rec.r - 1 && f.r <= rec.r).map((f) => `${f.T} ${f.r} ${f.phase} ${f.entry} toss ${f.toss}`))}`);
        }
        // (A roll rewritten once its show was over turns its faces where the
        // dice lie, in a later roll's frame: its own last landing may be on
        // any of its versions' faces.)
        const land = this.landOf(sp, rec.r);
        const faces = new Set(this.versions.filter((x) => x.r === rec.r && x.dice).map((x) => `land ${x.dice![0]}${x.dice![1]}`));
        if (faces.size === 1) faces.clear();
        faces.add(`land ${rec.dice[0]}${rec.dice[1]}`);
        if (land !== null && !faces.has(land)) this.problems.push(`${sp.name}'s dice came to rest on ${land} for roll ${rec.r}, its faces ${rec.dice.join('')}`);
      }
    }
  }
}

/** A decided roll as noteChanged's notice compares it: its dice, what it
 *  handed on, and what it paid (the design's "came to something else"). */
function rollKeyOf(v: RoundView): string {
  const o = v.craps!.sOut;
  return JSON.stringify([
    v.craps!.dice, o.p, o.h ?? null, o.a ?? null, o.i ?? 0, Object.keys(o.w).sort().map((pid) => [pid, o.w[pid]]),
    [...v.deltas].map(([pid, d]) => `${pid}:${d}`).sort(),
  ]);
}

// ── 🎬 The director: a plan a roll ───────────────────────────────────────────

interface Plan {
  r: number;
  step: string;
  /** The holder the case is about, and another player it moves. */
  X: SimPage | null;
  Y: SimPage | null;
  /** The sum the roll's seeds are rigged to (0: none), and a split: what
   *  the seed of `w` alone makes (rigSplit). */
  sum: number;
  split: { w: SimPage; alone: number } | null;
  /** A seed writer whose seed won't count (late). */
  without: SimPage | null;
  /** What each page puts down at the start of betting (null: nothing). */
  bets: Map<SimPage, CrapsBet | null>;
  betDone: Set<SimPage>;
  /** The carry the roll plays from. */
  K: CrapsCarry;
  /** How far into the wait the holder throws through its UI (none: it
   *  doesn't), and how: its key, or a flick of the dice. */
  throwOff: number | null;
  how: 'key' | 'flick';
  data: Record<string, number | undefined>;
}

class Director {
  readonly plans = new Map<number, Plan>();
  readonly rigMiss: string[] = [];
  rigHit = 0;
  /** A case's look at each page each tick (its view, on its clock). */
  each: ((plan: Plan, sp: SimPage, v: ComputedCrapsState, now: number) => void) | null = null;

  constructor(
    private readonly sim: Sim,
    private readonly stage: Stage,
    private readonly choose: (plan: Plan) => void,
    private readonly settle: (plan: Plan, rec: RollRec) => void,
  ) {}

  /** Roll 1's plan, at the start. */
  start(): void {
    this.open(1, { p: 0, w: Object.create(null) as Record<string, CrapsBet[]> });
  }

  /** A plan for roll r from carry K: every player at the table or the
   *  device front bets (the pass line on a come-out, the field mid-point),
   *  then the scenario's choice; its dice rigged. */
  private open(r: number, K: CrapsCarry): void {
    const craps = this.sim.craps!;
    const plan: Plan = {
      r, step: 'fill', X: null, Y: null, sum: 0, split: null, without: null, betDone: new Set(), K, data: {},
      throwOff: between(this.sim.rand, 2_000, 8_000), how: r % 2 === 0 ? 'key' : 'flick',
      bets: new Map(this.sim.pages.map((sp) => [sp, craps.placeOf(sp, T) === 'off' ? null : K.p === 0 ? { type: 'pass', amount: 10 } : { type: 'field', amount: 2 }])),
    };
    this.choose(plan);
    // (A page sent off the table by the choice bets nothing.)
    for (const sp of this.sim.pages) if (craps.placeOf(sp, T) === 'off') plan.bets.set(sp, null);
    this.plans.set(r, plan);
    this.rig(plan);
  }

  /** The pages whose seeds the roll will count: every page up that bets or
   *  has bets riding (a ride slip goes from the table, or from off it when
   *  others play), but the one left out. */
  writers(plan: Plan): SimPage[] {
    const craps = this.sim.craps!;
    return this.sim.pages.filter((q) => q.mode === 'up' && q !== plan.without
      && ((plan.bets.get(q) && craps.placeOf(q, T) !== 'off') || riding(plan.K, q.pid)));
  }

  private rig(plan: Plan): void {
    for (const sp of this.sim.pages) sp.p.seeds.length = 0;
    if (plan.sum === 0) return;
    const S = this.writers(plan);
    const ref = this.stage.ref();
    if (S.length === 0 || !ref) return;
    const ctx = this.sim.ctxOf(T, ref.p.casino.computedIncOf(T)!);
    if (plan.split) rigSplit(S.map((q) => q.p), plan.r, plan.sum, plan.split.w.p, plan.split.alone, ctx);
    else rigRoll(S.map((q) => q.p), plan.r, plan.sum, [], ctx);
  }

  /** Page sp's bet `add` on roll r through the felt's writer, as a press. */
  private bet(sp: SimPage, r: number, add: CrapsBet, now: number): void {
    const { table, casino } = sp.p;
    if (casino.readChips(sp.pid) < 100) this.sim.buyIn(sp, sp.pid, 1_000);
    const { felt, basis } = table.readMyComputedCrapsBets(T, sp.pid, r, now);
    const want = canonList([...felt, add]);
    const res = this.sim.craps!.press(sp, T, r, want, basis, () => table.writeComputedCrapsSlip(T, want, basis, now));
    // (A page catching up, back from a lag, answers 'reconnecting': it goes
    // again on its next frame, as the felt's own press would be tried again.)
    if (res === 'reconnecting') this.plans.get(r)?.betDone.delete(sp);
    else if (res !== 'ok') this.stage.problems.push(`${sp.name}'s bet ${JSON.stringify(add)} on roll ${r} at ${this.sim.elapsed} ms answered ${res}`);
  }

  /** No more plans or bets (the finish's quiet period). */
  stopped = false;

  tick(): void {
    if (this.stopped) return;
    let top = 0;
    for (const r of this.stage.rolls.keys()) top = Math.max(top, r);
    if (top > 0 && !this.plans.has(top + 1)) {
      const rec = this.stage.rolls.get(top)!;
      const plan = this.plans.get(top);
      if (plan) {
        if (plan.sum !== 0) {
          if (rec.sum === plan.sum) this.rigHit += 1;
          else this.rigMiss.push(`roll ${top} (${plan.step}) ${rec.sum}, rigged ${plan.sum}`);
        }
        this.settle(plan, rec);
      }
      this.open(top + 1, rec.sOut);
    }
    for (const sp of this.sim.pages) {
      if (sp.mode !== 'up' || this.sim.T < sp.pauseUntil) continue;
      const now = this.sim.enter(sp);
      const v = sp.p.table.readComputedCraps(T, now);
      if (!v) continue;
      // (A case's look goes to the roll after the view's too: its fakes in the
      // show before it.)
      const next = this.plans.get(v.round + 1);
      if (next) this.each?.(next, sp, v, now);
      const plan = this.plans.get(v.round);
      if (!plan) continue;
      if (v.phase === 'betting' && !plan.betDone.has(sp) && (v.phaseDeadline === undefined || now < v.phaseDeadline - 4_000)) {
        plan.betDone.add(sp);
        // (The default bet by the carry as it now reads: a rewrite of the
        // roll before may have moved the point since the plan was made.)
        const K = this.stage.rolls.get(v.round - 1)?.sOut ?? plan.K;
        const add: CrapsBet | null = plan.bets.get(sp) ? (K.p === 0 ? { type: 'pass', amount: 10 } : { type: 'field', amount: 2 }) : null;
        if (add && this.sim.craps!.placeOf(sp, T) !== 'off') this.bet(sp, v.round, add, now);
      }
      // The shooter's throw, through its UI, `throwOff` into the wait it is
      // offered (the view's own: the wait, this page's player the shooter).
      if (plan.throwOff !== null && v.round === plan.r && v.phase === 'closing' && v.phaseDeadline !== undefined && v.shooter === sp.pid
        && now >= v.phaseDeadline - this.stage.SHOOTER_MS + plan.throwOff && sp.p.table.computedFlungFor(T, now)?.r !== plan.r && this.stage.ui.has(sp)) {
        if (!this.stage.throwVia(sp, plan.how)) this.stage.problems.push(`${sp.name}'s ${plan.how} throw of roll ${plan.r} at ${this.sim.elapsed} ms didn't go`);
      }
      this.each?.(plan, sp, v, now);
    }
  }
}


/** The ⚙ card on page sp naming the markup player (as the holder, or as a
 *  forfeit's writer): the name escaped, never as markup. */
function cardCheck(stage: Stage, sp: SimPage, want: string): void {
  const html = stage.card(sp);
  if (!html.includes(want) || html.includes(MARKUP_UP) || html.includes(MARKUP)) {
    stage.problems.push(`${sp.name}'s ⚙ card doesn't name the player escaped (${JSON.stringify(want)}): ${html.slice(0, 600)}`);
  } else stage.cards += 1;
}

const wall = (t0: number): string => `${((performance.now() - t0) / 1000).toFixed(1)} s`;

/** A throw record for roll r in `by`'s name, written by page sp (a fake:
 *  anyone can write one). */
function fakeThrow(sp: SimPage, r: number, by: string, seed: number): void {
  sp.p.casino.writeDiceThrow(T, { round: r, by, sx: 0, sz: -0.3, dx: 0, dz: 1, power: 0.7, seed });
}

// ── 🎬 A scenario: its cases, roll by roll ───────────────────────────────────

/** A scenario under way: what its cases share. */
interface Run {
  readonly sim: Sim;
  readonly stage: Stage;
  /** Where each player stands at first, and goes back to after a case. */
  readonly home: Map<SimPage, Place>;
  readonly todo: string[];
  readonly done: Record<string, number>;
  /** The plans of the cases that played, in order. */
  readonly played: Plan[];
  /** A holder kept off the table from one case to the next. */
  away: SimPage | null;
  /** The scenario's own tallies. */
  readonly tally: Record<string, number>;
}

const pageOf = (sim: Sim, pid?: string): SimPage | undefined => sim.pages.find((q) => q.pid === pid);

/** The holder in play (counted at their stand on the last roll), at their
 *  own stand. */
function inPlay(c: Run, K: CrapsCarry): SimPage | null {
  const X = pageOf(c.sim, K.h);
  return X && K.i === 1 && c.sim.craps!.placeOf(X, T) === c.home.get(X) ? X : null;
}

/** The holder in play with the point on and bets of theirs riding (so a
 *  slip of theirs goes from off the table too: the ride slip). */
function inPlayRiding(c: Run, K: CrapsCarry): SimPage | null {
  const X = inPlay(c, K);
  return X && K.p !== 0 && riding(K, X.pid) ? X : null;
}

function toHome(c: Run, sp: SimPage): void {
  if (c.sim.craps!.placeOf(sp, T) === c.home.get(sp)) return;
  c.stage.move(sp, c.home.get(sp)!, c.sim.enter(sp));
}

/** The player stands nobody stands at now, in the ring's order. */
function freeStands(c: Run): number[] {
  const taken = new Set(c.sim.pages.map((q) => c.sim.craps!.placeOf(q, T)));
  return c.stage.order.filter((s) => !taken.has(s));
}

/** The end of roll plan.r's wait for the throw on a page's view (null: the
 *  view isn't in it), and of its betting. */
const waitEnd = (plan: Plan, v: ComputedCrapsState): number | null =>
  v.round === plan.r && v.phase === 'closing' && v.phaseDeadline !== undefined ? v.phaseDeadline : null;
const betEnd = (plan: Plan, v: ComputedCrapsState): number | null =>
  v.round === plan.r && v.phase === 'betting' && v.phaseDeadline !== undefined ? v.phaseDeadline : null;

/** The roll's first close (room time), its writer and the end of the wait on
 *  the writer's page. */
function firstOf(c: Run, r: number): { first: CloseSeen | null; by: SimPage | undefined; D: number | undefined } {
  const first = c.stage.firstClose(r);
  const by = first ? c.sim.pages.find((q) => q.name === first.by) : undefined;
  return { first, by, D: by ? c.stage.D(by, r) : undefined };
}

/** On page sp: whether the throw record for roll plan.r in `by`'s name came
 *  after the first close it saw (`late:<page>` 1, else 0). */
function noteLate(plan: Plan, sp: SimPage, by: string, tag = 'late'): void {
  const thr = sp.p.casino.readDiceThrow(T);
  if (!thr || thr.round !== plan.r || thr.by !== by) return;
  const at = sp.p.casino.computedThrowSeenAt(T, thr);
  const close = sp.p.table.computedCrapsClose(T, plan.r);
  if (at === undefined || !close) return;
  plan.data[`${tag}:${sp.name}`] = at > close.at ? 1 : 0;
}

/** A case: when a roll can play it, its plan, what it does each tick, whether
 *  the roll played it, and what the design says it showed. */
interface Case {
  /** Whether roll r, from carry K, can play it. */
  ready(c: Run, K: CrapsCarry, r: number): boolean;
  setup(c: Run, plan: Plan): void;
  each?(c: Run, plan: Plan, sp: SimPage, v: ComputedCrapsState, now: number): void;
  ok(c: Run, plan: Plan, rec: RollRec): boolean;
  /** After its roll, played or not (default: everyone but a player kept
   *  away back at their stand). */
  then?(c: Run, plan: Plan, ok: boolean): void;
  check(c: Run, plan: Plan, P: string[]): void;
}

interface Scenario {
  /** Its name in the timings, and its sim's. */
  name: string;
  label: string;
  seed: number;
  pages: PageSpec[];
  /** The page whose player is named in markup. */
  markup: number;
  cases: Record<string, Case>;
  /** A roll no case is ready for: toward the next one. */
  fill(c: Run, plan: Plan): void;
  /** Every page each tick, whatever the case. */
  each?: (c: Run, plan: Plan, sp: SimPage, v: ComputedCrapsState, now: number) => void;
  /** The notice oracle on (Stage notices). */
  notices?: boolean;
  /** Once the stage is up, before the first roll. */
  start?: (c: Run) => void;
  minutes?: number;
  finish?: Finish;
  /** More flights a roll may have on a page (a rewrite). */
  flights?: (c: Run, sp: SimPage, r: number) => number;
}

/** Scenario sc played: every case once (the director rolling toward each),
 *  then the shared finish; every played case's roll has one close, every
 *  roll's holder after it the ring's, one flight a roll on every page. */
async function play(sc: Scenario): Promise<{ c: Run; s: SimSummary; P: string[]; passes: number }> {
  const t0 = performance.now();
  const sim = await Sim.open({ name: sc.label, seed: sc.seed, tables: crapsTable, pages: sc.pages });
  try {
    return await played(sc, sim);
  } finally {
    timings.push(`${sc.name}: ${wall(t0)} wall, ${(sim.elapsed / 60_000).toFixed(1)} sim-min`);
  }
}

async function played(sc: Scenario, sim: Sim): Promise<{ c: Run; s: SimSummary; P: string[]; passes: number }> {
  const craps = sim.craps!;
  const M = sim.pages[sc.markup];
  const stage = await Stage.open(sim, M);
  stage.noticeOracle = sc.notices === true;
  const c: Run = {
    sim, stage, home: new Map(sim.pages.map((sp) => [sp, craps.placeOf(sp, T)])), todo: Object.keys(sc.cases), done: {}, played: [], away: null, tally: {},
  };
  const choose = (plan: Plan): void => {
    const step = c.todo.find((s) => sc.cases[s].ready(c, plan.K, plan.r));
    if (step === undefined) {
      sc.fill(c, plan);
      return;
    }
    plan.step = step;
    sc.cases[step].setup(c, plan);
  };
  const settle = (plan: Plan, rec: RollRec): void => {
    const k = sc.cases[plan.step];
    if (!k) return;
    const ok = k.ok(c, plan, rec);
    for (const q of sim.pages) stage.pre.delete(q);
    if (ok) {
      c.done[plan.step] = (c.done[plan.step] ?? 0) + 1;
      c.played.push(plan);
      c.todo.splice(c.todo.indexOf(plan.step), 1);
    }
    if (k.then) k.then(c, plan, ok);
    else for (const q of sim.pages) if (q !== c.away) toHome(c, q);
  };
  const director = new Director(sim, stage, choose, settle);
  director.each = (plan, sp, v, now) => {
    sc.cases[plan.step]?.each?.(c, plan, sp, v, now);
    sc.each?.(c, plan, sp, v, now);
    // The ⚙ card names the markup holder escaped.
    if (stage.cards === 0 && sp !== M && stage.ui.has(sp) && v.round === plan.r && v.phase === 'betting' && v.holder === M.pid) cardCheck(stage, sp, `${MARKUP_ESC} HAS THE DICE`);
  };
  sim.every(() => {
    stage.tick();
    director.tick();
  });
  sc.start?.(c);
  director.start();
  while (c.todo.length > 0 && sim.elapsed < (sc.minutes ?? 14) * 60_000) await sim.run(15_000);
  await sim.run(12_000);
  director.stopped = true;
  sim.net.reset();
  for (const sp of sim.pages) {
    sim.enter(sp);
    stage.unmount(sp);
  }
  // (The shared finish first; what the scenario's own oracles found is
  // printed with its failure too.)
  let s: SimSummary | null = null;
  let failed: unknown = null;
  try {
    s = await finish(sim, lines, sc.finish);
  } catch (e) {
    failed = e;
  }
  const P = stage.problems;
  for (const plan of c.played) {
    const one = stage.closesOf(plan.r);
    if (one.length !== 1) P.push(`${plan.step} roll ${plan.r}: ${one.length} closes ${JSON.stringify(one)}`);
    sc.cases[plan.step].check(c, plan, P);
  }
  // (A roll the room rewrote, or played again: the pages showed each
  // version's result line; the holder rule holds of its last.)
  const passes = stage.checkHolders((_sp, r) => stage.versions.filter((x) => x.r === r).length > 1);
  stage.checkFlights(sc.flights ? (sp, r) => sc.flights!(c, sp, r) : undefined);
  // The competing closes over the whole run, counted.
  const rival = [...stage.closes].filter(([, m]) => m.size > 1).map(([r, m]) => `${r}: ${[...m.values()].map((x) => x.by).join('+')}`);
  c.tally.rival = rival.length;
  console.log(`[craps] ${sim.label}: cases ${JSON.stringify(c.done)}, tallies ${JSON.stringify(c.tally)}, rival closes ${JSON.stringify(rival)}, passes ${passes}, `
    + `named ${stage.named}, cards ${stage.cards}, notices rewritten ${stage.rewritten} changed ${stage.changed}, rigs ${director.rigHit} hit, missed ${JSON.stringify(director.rigMiss)}, timesUp ${craps.stats.timesUp}`);
  if (failed !== null) {
    console.log(`[craps] ${sim.label}: the finish failed; the scenario's own oracles found ${JSON.stringify(P.slice(0, 20), null, 1)}`);
    throw failed;
  }
  return { c, s: s!, P, passes };
}

/** What every scenario holds to once it is over: no problem, every case
 *  played, the markup player named on other pages and on a ⚙ card. */
function held(sc: Scenario, r: { c: Run; s: SimSummary; P: string[] }): void {
  const label = r.c.sim.label;
  // (Soft: a problem fails the run, and the case assertions after it still
  // run and report, one problem hiding none of them.)
  expect.soft(r.P, label).toEqual([]);
  for (const k of Object.keys(sc.cases)) expect(r.c.done[k] ?? 0, `${label} ${k}`).toBeGreaterThan(0);
  expect(r.c.stage.named, label).toBeGreaterThan(0);
  expect(r.c.stage.cards, label).toBeGreaterThan(0);
  expect(r.s.rounds, label).toBeGreaterThan(0);
}

/** The fill toward the shooter's and the stand cases: a point on with the
 *  holder in play (a point on a come-out, then whatever comes), or a fresh
 *  hand (a seven: out, or a natural that passes the dice of a holder who
 *  wasn't counted). */
function fillToPoint(c: Run, plan: Plan, comeOut: boolean): void {
  const K = plan.K;
  const X = inPlay(c, K);
  plan.sum = comeOut ? 7 : K.p === 0 && X === null && K.h !== undefined ? 7 : K.p === 0 ? pick(c.sim.rand, POINTS) : 7;
}

// ── 🧍 Back at the stand at the end of the wait (shooter, stand-change) ──────

/**
 * The holder, in play with bets riding and the point on, off the table as
 * betting runs and ends (their ride slip goes); back at their stand `off`
 * ms from the end of the wait on their page (D), and then:
 * - before it (0.2 s): they throw through the table UI at once. Their stand
 *   rewrite is a change seen within STAGGER_MS of D, so their page gives
 *   its turn away (crapsCloseDue, design E AS1: "a shooter back at their
 *   stand in the last 1.5 s who flings no longer closes the roll at the
 *   fling; the first close comes at D + 1.5 s at the earliest"): one close,
 *   by another page, with their stand, so they are counted there and, on
 *   the roll that makes the point (rigged), keep the dice;
 * - after it (0.1 s): their own page closed the roll at D over their ride
 *   slip, a slip of its own with chips (design step 5: "the shooter's own
 *   page closes when its player flings, or when their 20 s run out, but
 *   only if they have a bet down"); back after that close, they write
 *   nothing more: no stand rewrite (crapsDutyOn shuts with the close in),
 *   no second close, and their key is refused. One close, theirs, at D,
 *   without their stand: not counted, they lose the dice on the point made.
 */
function edgeCase(off: number): Case {
  const before = off < 0;
  return {
    ready: (c, K) => inPlayRiding(c, K) !== null,
    setup(c, plan) {
      const X = plan.X = inPlayRiding(c, plan.K)!;
      c.stage.move(X, 'off', c.sim.enter(X));
      plan.throwOff = null;
      plan.sum = plan.K.p;
    },
    each(c, plan, sp, v) {
      const X = plan.X!;
      const D = waitEnd(plan, v);
      if (sp !== X || D === null || plan.data.at !== undefined) return;
      plan.data.at = D + off;
      plan.data.D = D;
      c.stage.precise(X, D + off, (now) => {
        c.stage.move(X, c.home.get(X)!, now);
        plan.data.back = now;
        if (before) {
          if (c.stage.throwVia(X, 'key')) plan.data.thrown = now;
        } else {
          plan.data.saidAt = c.stage.said.length;
          c.stage.key(X, 'r');
          plan.data.keyed = now;
        }
      });
    },
    ok(_c, plan, rec) {
      return plan.data.back !== undefined && (before ? plan.data.thrown !== undefined : plan.data.keyed !== undefined)
        && rec.pointBefore !== null && rec.pointAfter === null && !rec.sevenOut;
    },
    then(c, _plan, ok) {
      for (const q of c.sim.pages) toHome(c, q);
      if (ok) c.tally[before ? 'edgeKept' : 'edgeLost'] = (c.tally[before ? 'edgeKept' : 'edgeLost'] ?? 0) + 1;
    },
    check(c, plan, P) {
      const X = plan.X!;
      const r = plan.r;
      const rec = c.stage.rolls.get(r)!;
      const what = `back ${before ? 'before' : 'after'} the wait's end roll ${r} (${X.name} at ${plan.data.back}, D ${plan.data.D})`;
      const STAGGER = c.sim.pages[0].p.table.STAGGER_MS;
      const { first, D } = firstOf(c, r);
      const others = c.sim.pages.filter((q) => q !== X);
      if (before) {
        if (!first || first.by === X.name || D === undefined || first.at! < D + STAGGER) P.push(`${what}: the first close ${JSON.stringify(first)}, the closer's wait to ${D}`);
        // Counted at their stand: the slip the close froze has it; they
        // keep the dice on the point made.
        if (rec.slips.get(X.pid)?.t !== c.home.get(X) || !rec.seated.has(X.pid)) P.push(`${what}: ${X.name} not counted at stand ${c.home.get(X)}: ${JSON.stringify(rec.slips.get(X.pid))}`);
        if (rec.sOut.h !== X.pid || rec.sOut.i !== 1) P.push(`${what}: the dice went to ${rec.sOut.h} (in play ${rec.sOut.i ?? 0})`);
        // Their throw went, and every page flew it (seen before any close).
        const own = c.stage.flung.get(`${X.name}|${r}`);
        for (const q of c.sim.pages) {
          const fl = c.stage.throwsOf(q, r).map((f) => seedOf(f.entry));
          if (own === undefined || fl.length !== 1 || fl[0] !== own) P.push(`${what}: ${q.name} flew ${JSON.stringify(fl)}, ${X.name}'s throw ${own}`);
        }
      } else {
        if (!first || first.by !== X.name || D === undefined || first.at! !== D) P.push(`${what}: the first close ${JSON.stringify(first)} isn't the holder's at its wait's end ${D}`);
        if (rec.slips.get(X.pid)?.t !== undefined || rec.seated.has(X.pid)) P.push(`${what}: ${X.name} counted at a stand by a close before they came back: ${JSON.stringify(rec.slips.get(X.pid))}`);
        if (rec.sOut.h === X.pid) P.push(`${what}: ${X.name} kept the dice though not counted at their stand when the point was made`);
        // Refused, no throw of theirs: the stickman's toss everywhere.
        const said = c.stage.said.slice(plan.data.saidAt).filter((x) => x.page === X.name && x.kind === 'notice');
        if (!said.some((x) => x.text === 'The dice are not yours to throw.')) P.push(`${what}: ${X.name}'s key wasn't refused: ${JSON.stringify(said.map((x) => x.text))}`);
        if (c.stage.throws.some((x) => x.round === r && x.by === X.pid)) P.push(`${what}: a throw by ${X.name} went out`);
        for (const q of c.sim.pages) {
          const fl = c.stage.throwsOf(q, r);
          if (fl.length !== 1 || seedOf(fl[0].entry) !== fl[0].toss) P.push(`${what}: ${q.name} flew ${JSON.stringify(fl)}, not the stickman's toss`);
        }
        for (const q of others) {
          const qs = c.stage.lines(q, r);
          if (qs.length > 0 && !qs.some((t) => t.includes(`WAITING FOR ${c.stage.name(X.pid)} · THE STICKMAN THROWS IN`))) P.push(`${what}: ${q.name} never read WAITING FOR: ${JSON.stringify(qs)}`);
        }
      }
    },
  };
}

// ── 🎲 Who shoots ────────────────────────────────────────────────────────────

/** The fake throw's seed (plus the roll). */
const FAKE = 900_000_000;

function shooterCases(n: number): Record<string, Case> {
  const kinds = ['natural', 'craps', 'point'];
  const name = (c: Run, sp: SimPage): string => c.stage.name(sp.pid);
  return {
    // (Ready only once awayKeep kept the dice away: first, so it comes next.)
    awayLose: {
      ready: (c, K) => c.away !== null && K.h === c.away.pid && K.p !== 0 && K.i !== 1,
      setup(c, plan) {
        plan.X = c.away!;
        plan.sum = plan.K.p;
      },
      ok: (_c, plan, rec) => rec.pointBefore !== null && rec.pointAfter === null && !rec.sevenOut && rec.sOut.h !== plan.X!.pid,
      then(c, plan, ok) {
        const X = plan.X!;
        if (!ok && c.stage.rolls.get(plan.r)?.sOut.h === X.pid) return;
        // (The dice gone some other way: the case again from the start.)
        if (!ok) c.todo.push('awayKeep');
        c.away = null;
        toHome(c, X);
      },
      check(c, plan, P) {
        // Not in play: no wait; the stickman throws when betting ends.
        const waited = c.sim.pages.filter((q) => c.stage.D(q, plan.r) !== undefined).map((q) => q.name);
        if (waited.length > 0) P.push(`away roll ${plan.r}: ${waited.join(', ')} waited for a throw`);
      },
    },
    fake: {
      ready: (c, K) => inPlay(c, K) !== null,
      setup(c, plan) {
        // The holder throws 9-14 s into the wait; another page writes a
        // throw record in their name 1.5-5 s into it.
        plan.X = inPlay(c, plan.K)!;
        plan.throwOff = between(c.sim.rand, 9_000, 14_000);
        plan.data.fakeOff = between(c.sim.rand, 1_500, 5_000);
        plan.sum = keepSum(c.sim.rand, plan.K.p);
      },
      each(c, plan, sp, v, now) {
        const D = waitEnd(plan, v);
        if (sp === plan.X || plan.data.fakeT !== undefined || D === null || now < D - c.stage.SHOOTER_MS + plan.data.fakeOff!) return;
        fakeThrow(sp, plan.r, plan.X!.pid, FAKE + plan.r);
        plan.data.fakeT = c.sim.elapsed;
      },
      ok: (c, plan) => plan.data.fakeT !== undefined && c.stage.flung.has(`${plan.X!.name}|${plan.r}`),
      check(c, plan, P) {
        // Only the animation: the holder still threw, their page closed at
        // the fling before the wait ran out, and flew its own throw; the
        // others flew one throw each, the fake on some.
        const X = plan.X!;
        const r = plan.r;
        const { first, D } = firstOf(c, r);
        const own = c.stage.flung.get(`${X.name}|${r}`)!;
        const mine = c.stage.throwsOf(X, r).map((f) => f.entry);
        if (JSON.stringify(mine) !== JSON.stringify([`throw ${own}`])) P.push(`fake roll ${r}: the holder ${X.name} flew ${JSON.stringify(mine)}, not its own ${own}`);
        if (!first || first.by !== X.name || D === undefined || first.at! >= D) P.push(`fake roll ${r}: the first close ${JSON.stringify(first)} isn't the holder's before the wait's end ${D}`);
        let faked = 0;
        for (const q of c.sim.pages.filter((x) => x !== X)) {
          const fl = c.stage.throwsOf(q, r);
          const sd = fl.length === 1 ? seedOf(fl[0].entry) : null;
          if (sd === FAKE + r) faked += 1;
          if (fl.length !== 1 || (sd !== FAKE + r && sd !== own && sd !== fl[0].toss)) P.push(`fake roll ${r}: ${q.name} flew ${JSON.stringify(fl)}`);
        }
        if (faked === 0) P.push(`fake roll ${r}: no page flew the fake throw`);
        const xs = c.stage.lines(X, r);
        if (!xs.some((t) => t.startsWith('🎲 YOUR ROLL'))) P.push(`fake roll ${r}: ${X.name} never read YOUR ROLL: ${JSON.stringify(xs)}`);
        if (xs.some((t) => t.includes("TIME'S UP"))) P.push(`fake roll ${r}: ${X.name} read TIME'S UP: ${JSON.stringify(xs)}`);
      },
    },
    back: {
      ready: (c, K) => inPlayRiding(c, K) !== null,
      setup(c, plan) {
        // Off the table as betting runs and ends; back at the stand 2-10 s
        // into the wait, throwing at once.
        const X = plan.X = inPlayRiding(c, plan.K)!;
        c.stage.move(X, 'off', c.sim.enter(X));
        plan.throwOff = 0;
        plan.data.backOff = between(c.sim.rand, 2_000, 10_000);
        plan.sum = plan.K.p;
      },
      each(c, plan, sp, v, now) {
        const D = waitEnd(plan, v);
        if (sp !== plan.X || plan.data.backT !== undefined || D === null || now < D - c.stage.SHOOTER_MS + plan.data.backOff!) return;
        c.stage.move(sp, c.home.get(sp)!, now);
        plan.data.backT = now;
      },
      ok(c, plan, rec) {
        const X = plan.X!;
        return plan.data.backT !== undefined && rec.slips.get(X.pid)?.t === c.home.get(X) && rec.seated.has(X.pid)
          && rec.pointBefore !== null && rec.pointAfter === null && !rec.sevenOut && rec.sOut.h === X.pid;
      },
      check(c, plan, P) {
        // Waiting for them while they were away; their stand on the slip
        // the close froze, their own throw.
        const X = plan.X!;
        for (const q of c.sim.pages.filter((x) => x !== X)) {
          const qs = c.stage.lines(q, plan.r);
          if (qs.length > 0 && !qs.some((t) => t.includes(`WAITING FOR ${name(c, X)} · THE STICKMAN THROWS IN`))) P.push(`back roll ${plan.r}: ${q.name} never read WAITING FOR ${name(c, X)}: ${JSON.stringify(qs)}`);
        }
        if (!c.stage.flung.has(`${X.name}|${plan.r}`)) P.push(`back roll ${plan.r}: ${X.name} didn't throw`);
      },
    },
    awayKeep: {
      ready: (c, K) => inPlayRiding(c, K) !== null,
      setup(c, plan) {
        const X = plan.X = inPlayRiding(c, plan.K)!;
        c.stage.move(X, 'off', c.sim.enter(X));
        c.away = X;
        plan.sum = keepSum(c.sim.rand, plan.K.p);
      },
      ok(_c, plan, rec) {
        const X = plan.X!;
        return !rec.seated.has(X.pid) && rec.pointBefore !== null && rec.pointAfter === rec.pointBefore && rec.sOut.h === X.pid;
      },
      then(c, plan, ok) {
        if (ok) return;
        c.away = null;
        toHome(c, plan.X!);
      },
      check(c, plan, P) {
        const X = plan.X!;
        for (const q of c.sim.pages.filter((x) => x !== X)) {
          const qs = c.stage.lines(q, plan.r);
          if (qs.length > 0 && !qs.some((t) => t.includes(`WAITING FOR ${name(c, X)} · `) || t.includes(`${name(c, X)} ISN'T HERE · `))) P.push(`away roll ${plan.r}: ${q.name} never read WAITING FOR ${name(c, X)}: ${JSON.stringify(qs)}`);
        }
        const { first, D } = firstOf(c, plan.r);
        if (!first || D === undefined || first.at! < D) P.push(`away roll ${plan.r}: closed ${JSON.stringify(first)} before the wait ended (${D})`);
      },
    },
    noBet: {
      ready: (c, K) => inPlay(c, K) !== null && K.p === 0 && !riding(K, K.h!),
      setup(c, plan) {
        const X = plan.X = inPlay(c, plan.K)!;
        plan.bets.set(X, null);
        plan.data.cls = (n + (c.tally.noBet ?? 0)) % 3;
        const cls = kinds[plan.data.cls];
        plan.sum = cls === 'natural' ? pick(c.sim.rand, [7, 11]) : cls === 'craps' ? pick(c.sim.rand, [2, 3, 12]) : pick(c.sim.rand, POINTS);
      },
      ok(c, plan, rec) {
        const ok = !rec.slips.has(plan.X!.pid) && rec.pointBefore === null && rec.sOut.h !== plan.X!.pid;
        if (ok) c.tally[kinds[plan.data.cls!]] = (c.tally[kinds[plan.data.cls!]] ?? 0) + 1;
        return ok;
      },
      check(c, plan, P) {
        // The full 20 s and the first turn after it, from a page with chips;
        // the words on the holder's page and on the others.
        const X = plan.X!;
        const r = plan.r;
        const xs = c.stage.lines(X, r);
        if (!xs.some((t) => t.startsWith('✋ NO MORE BETS — YOU HAVE NO BET DOWN · THE STICKMAN THROWS IN'))) P.push(`no bet roll ${r}: ${X.name} read ${JSON.stringify(xs)}`);
        for (const q of c.sim.pages.filter((x) => x !== X)) {
          const qs = c.stage.lines(q, r);
          if (!qs.some((t) => t.startsWith(`✋ NO MORE BETS — ${name(c, X)} HAS NO BET DOWN · THE STICKMAN THROWS IN`))) P.push(`no bet roll ${r}: ${q.name} read ${JSON.stringify(qs)}`);
        }
        const { first, D } = firstOf(c, r);
        if (!first || first.by === X.name || D === undefined || first.at! < D + c.sim.pages[0].p.table.STAGGER_MS) P.push(`no bet roll ${r}: first close ${JSON.stringify(first)}, the wait to ${D}`);
      },
    },
    late: {
      ready: (c, K) => inPlayRiding(c, K) !== null,
      setup(c, plan) {
        // Its seed out 15 s after the close (its frames stop: a throttled
        // tab): the others' seeds make the point.
        const X = plan.X = inPlayRiding(c, plan.K)!;
        plan.throwOff = between(c.sim.rand, 2_000, 6_000);
        plan.without = X;
        plan.sum = plan.K.p;
        const r = plan.r;
        c.stage.pre.set(X, () => {
          const tip = X.p.casino.computedFoldOf(T)?.tip;
          if (plan.data.paused === undefined && tip && tip.r === r && tip.present.includes(X.pid) && !tip.revealed.includes(X.pid)) {
            plan.data.paused = c.sim.elapsed;
            X.pauseUntil = c.sim.T + 15_000;
            return false;
          }
          return true;
        });
      },
      ok(_c, plan, rec) {
        const X = plan.X!;
        return plan.data.paused !== undefined && rec.decided === 'forfeit' && !rec.counted.includes(X.pid)
          && rec.pointBefore !== null && rec.pointAfter === null && !rec.sevenOut && rec.sOut.h !== X.pid;
      },
      check() {},
    },
    lone: {
      ready: (c, K) => inPlayRiding(c, K) !== null,
      setup(c, plan) {
        // Everyone else bets from the device front: no stand, so not
        // seated; the holder sevens out alone.
        const X = plan.X = inPlayRiding(c, plan.K)!;
        for (const q of c.sim.pages) if (q !== X) c.stage.move(q, null, c.sim.enter(q));
        plan.sum = 7;
      },
      ok: (_c, plan, rec) => rec.sevenOut && rec.sOut.h === plan.X!.pid,
      check(c, plan, P) {
        const xs = c.stage.lines(plan.X!, plan.r).filter((t) => t.startsWith('● '));
        if (!xs.some((t) => t.includes('THE DICE COME BACK TO YOU'))) P.push(`lone roll ${plan.r}: ${plan.X!.name} read ${JSON.stringify(xs)}`);
      },
    },
    timesUp: {
      ready: (c, K) => inPlay(c, K) !== null && K.p !== 0,
      setup(c, plan) {
        plan.X = inPlay(c, plan.K)!;
        plan.throwOff = null;
        plan.sum = 7;
      },
      each(c, plan, sp, v, now) {
        // TIME'S UP through the UI's own fling: the dice picked up 3 s
        // before the wait ends and held past it; let go, and the key.
        const X = plan.X!;
        if (sp !== X) return;
        const D = waitEnd(plan, v);
        if (plan.data.grabbed === undefined && D !== null && now >= D - 3_000) {
          c.stage.grab(X);
          plan.data.grabbed = now;
        } else if (plan.data.grabbed !== undefined && plan.data.letGo === undefined && v.round === plan.r && v.phaseDeadline === undefined) {
          c.stage.letGo(X);
          c.stage.key(X, 'r');
          plan.data.letGo = now;
        }
      },
      ok: (c, plan, rec) => !c.stage.flung.has(`${plan.X!.name}|${plan.r}`) && plan.data.grabbed !== undefined && rec.sevenOut,
      check(c, plan, P) {
        // The offer, then TIME'S UP; the dice it held dropped, its key
        // refused, no throw of its own; nothing closed before the wait ran
        // out.
        const X = plan.X!;
        const r = plan.r;
        const xs = c.stage.lines(X, r);
        const offer = xs.findIndex((t) => t.startsWith('🎲 YOUR ROLL'));
        const up = xs.findIndex((t) => t.startsWith("✋ TIME'S UP — THE STICKMAN THREW"));
        if (offer < 0 || up < offer) P.push(`TIME'S UP roll ${r}: ${X.name} read ${JSON.stringify(xs)}`);
        if (!c.stage.notice(X).includes('The dice are not yours to throw.')) P.push(`TIME'S UP roll ${r}: ${X.name}'s key wasn't refused: ${JSON.stringify(c.stage.notice(X).slice(-5))}`);
        if (c.stage.throws.some((x) => x.round === r && x.by === X.pid)) P.push(`TIME'S UP roll ${r}: a throw by ${X.name} went out`);
        const { first, D } = firstOf(c, r);
        if (!first || D === undefined || first.at! < D) P.push(`TIME'S UP roll ${r}: closed ${JSON.stringify(first)} before the wait ended (${D})`);
      },
    },
    edgeBefore: edgeCase(-200),
    edgeAfter: edgeCase(100),
  };
}

describe('computed craps: the shooter', () => {
  for (const n of SEEDS) {
    it(`shooter ${n}: the dice pass clockwise; TIME'S UP; a fake throw; a shooter away, back during the wait and at its edges, with no bet down, with a late seed, alone`, async () => {
      uiDom();
      try {
        // A at stand 3, the ring's first; then B (4), C (2), D (1). A's
        // player is named in markup.
        const sc: Scenario = {
          name: `shooter ${n}`, label: 'craps-shooter', seed: seed(4100 + n), markup: 0,
          pages: [pageAt('A', 3), pageAt('B', 4), pageAt('C', 2), pageAt('D', 1)],
          cases: shooterCases(n),
          fill: (c, plan) => fillToPoint(c, plan, c.todo.find((s) => s !== 'awayLose') === 'noBet'),
        };
        const r = await play(sc);
        held(sc, r);
        expect(r.passes, r.c.sim.label).toBeGreaterThanOrEqual(2);
        expect(r.c.sim.craps!.stats.timesUp, r.c.sim.label).toBeGreaterThan(0);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});

// ── 🧍 Stands changed ────────────────────────────────────────────────────────

/** Page sp to a free stand (one of `avoid` left alone), at its clock now;
 *  the stand it went to. */
function toFree(c: Run, sp: SimPage, now: number, avoid: number[] = []): number | null {
  const free = freeStands(c).filter((s) => !avoid.includes(s));
  if (free.length === 0) return null;
  const to = pick(c.sim.rand, free);
  c.stage.move(sp, to, now);
  return to;
}

function standCases(): Record<string, Case> {
  /** Another player at a stand, with chips on the roll. */
  const other = (c: Run, plan: Plan, not: SimPage[]): SimPage =>
    pick(c.sim.rand, c.sim.pages.filter((q) => !not.includes(q) && typeof c.sim.craps!.placeOf(q, T) === 'number' && plan.bets.get(q)));
  return {
    // Roll 1 (nobody holds the dice: no wait, the turns from the end of
    // betting): a player changes stands 0.1-1.4 s before it. The close
    // freezes the slip its writer had heard, either stand; one close (a
    // late change gives its page's turn away, closeDue).
    nearEndOpen: {
      ready: (_c, K) => K.h === undefined || K.i !== 1,
      setup(c, plan) {
        plan.Y = other(c, plan, []);
        plan.data.from = c.sim.craps!.placeOf(plan.Y, T) as number;
        plan.data.off = between(c.sim.rand, 100, 1_400);
        plan.sum = plan.K.p === 0 ? pick(c.sim.rand, POINTS) : keepSum(c.sim.rand, plan.K.p);
      },
      each(c, plan, sp, v) {
        const W = betEnd(plan, v);
        if (sp !== plan.Y || W === null || plan.data.at !== undefined) return;
        plan.data.at = W - plan.data.off!;
        c.stage.precise(sp, W - plan.data.off!, (now) => {
          plan.data.to = toFree(c, sp, now) ?? undefined;
        });
      },
      ok: (_c, plan, rec) => plan.data.to !== undefined && rec.slips.has(plan.Y!.pid),
      check(c, plan, P) {
        const t = c.stage.rolls.get(plan.r)!.slips.get(plan.Y!.pid)?.t;
        if (t !== plan.data.from && t !== plan.data.to) P.push(`near the end of betting (no wait) roll ${plan.r}: ${plan.Y!.name}'s slip froze at stand ${t}, it moved ${plan.data.from} → ${plan.data.to}`);
        c.tally[t === plan.data.to ? 'openNew' : 'openOld'] = (c.tally[t === plan.data.to ? 'openNew' : 'openOld'] ?? 0) + 1;
      },
    },
    // Mid-hand, early in betting: the holder and a player who doesn't come
    // after them round the ring both change stands, the player to the stand
    // right after the holder's new one; a seven-out passes the dice to them.
    midHand: {
      ready: (c, K) => inPlayRiding(c, K) !== null && freeStands(c).length >= 2,
      setup(c, plan) {
        const X = plan.X = inPlayRiding(c, plan.K)!;
        const ring = c.stage.order.filter((s) => c.sim.pages.some((q) => c.sim.craps!.placeOf(q, T) === s));
        const xAt = c.sim.craps!.placeOf(X, T) as number;
        const next = ring[(ring.indexOf(xAt) + 1) % ring.length];
        plan.Y = other(c, plan, [X, ...c.sim.pages.filter((q) => c.sim.craps!.placeOf(q, T) === next)]);
        // The holder's new stand, and the free stand after it in the ring
        // with no player between.
        const free = freeStands(c);
        for (const s of free) {
          const i = c.stage.order.indexOf(s);
          const after = c.stage.order[(i + 1) % c.stage.order.length];
          if (free.includes(after)) {
            plan.data.xTo = s;
            plan.data.yTo = after;
            break;
          }
        }
        plan.data.off = between(c.sim.rand, 8_000, 12_000);
        plan.sum = 7;
      },
      each(c, plan, sp, v, now) {
        const W = betEnd(plan, v);
        if (W === null || now < W - plan.data.off! || plan.data.xTo === undefined) return;
        if (sp === plan.X && plan.data.xAt === undefined) {
          c.stage.move(sp, plan.data.xTo, now);
          plan.data.xAt = now;
        }
        if (sp === plan.Y && plan.data.yAt === undefined) {
          c.stage.move(sp, plan.data.yTo!, now);
          plan.data.yAt = now;
        }
      },
      ok(_c, plan, rec) {
        return plan.data.xAt !== undefined && plan.data.yAt !== undefined && rec.slips.get(plan.X!.pid)?.t === plan.data.xTo
          && rec.slips.get(plan.Y!.pid)?.t === plan.data.yTo && rec.sevenOut;
      },
      check(c, plan, P) {
        const rec = c.stage.rolls.get(plan.r)!;
        if (rec.sOut.h !== plan.Y!.pid || rec.sOut.i !== 1) P.push(`mid-hand roll ${plan.r}: the dice went to ${rec.sOut.h}, not ${plan.Y!.name} at the stand after ${plan.X!.name}'s new one (${plan.data.xTo} → ${plan.data.yTo})`);
      },
    },
    // Near the end of betting with the holder in play: the holder 0.2-1.4 s
    // before it, another player 0.1-1.4 s before it; the close (the
    // holder's fling) freezes both new stands, and the holder keeps the dice.
    nearEnd: {
      ready: (c, K) => inPlayRiding(c, K) !== null && freeStands(c).length >= 2,
      setup(c, plan) {
        plan.X = inPlayRiding(c, plan.K)!;
        plan.Y = other(c, plan, [plan.X]);
        plan.data.xOff = between(c.sim.rand, 200, 1_400);
        plan.data.yOff = between(c.sim.rand, 100, 1_400);
        plan.sum = keepSum(c.sim.rand, plan.K.p);
      },
      each(c, plan, sp, v) {
        const W = betEnd(plan, v);
        if (W === null) return;
        for (const [who, off, key] of [[plan.X!, plan.data.xOff!, 'x'], [plan.Y!, plan.data.yOff!, 'y']] as const) {
          if (sp !== who || plan.data[`${key}Sched`] !== undefined) continue;
          plan.data[`${key}Sched`] = W - off;
          c.stage.precise(sp, W - off, (now) => {
            plan.data[`${key}To`] = toFree(c, sp, now, [plan.data.xTo ?? 0, plan.data.yTo ?? 0]) ?? undefined;
          });
        }
      },
      ok(_c, plan, rec) {
        return plan.data.xTo !== undefined && plan.data.yTo !== undefined && rec.slips.get(plan.X!.pid)?.t === plan.data.xTo
          && rec.slips.get(plan.Y!.pid)?.t === plan.data.yTo;
      },
      check(c, plan, P) {
        const rec = c.stage.rolls.get(plan.r)!;
        if (rec.sOut.h !== plan.X!.pid || rec.sOut.i !== 1) P.push(`near the end of betting roll ${plan.r}: the dice went to ${rec.sOut.h} (in play ${rec.sOut.i ?? 0}), not ${plan.X!.name} at its new stand`);
        const { first } = firstOf(c, plan.r);
        if (!first || first.by !== plan.X!.name) P.push(`near the end of betting roll ${plan.r}: the first close ${JSON.stringify(first)} isn't the holder's fling`);
      },
    },
    // Both late: the holder (no throw) 0.3 s before the wait ends, another
    // bettor 0.2 s after it. Both pages give their turns away (a change
    // within STAGGER_MS of D, or after it); a third page closes, from D +
    // STAGGER_MS, with both new stands; the holder, counted, keeps the dice
    // on the point made.
    bothLate: {
      ready: (c, K) => inPlayRiding(c, K) !== null && freeStands(c).length >= 2,
      setup(c, plan) {
        plan.X = inPlayRiding(c, plan.K)!;
        plan.Y = other(c, plan, [plan.X]);
        plan.throwOff = null;
        plan.sum = plan.K.p;
      },
      each(c, plan, sp, v) {
        const D = waitEnd(plan, v);
        if (D === null) return;
        for (const [who, off, key] of [[plan.X!, -300, 'x'], [plan.Y!, 200, 'y']] as const) {
          if (sp !== who || plan.data[`${key}Sched`] !== undefined) continue;
          plan.data[`${key}Sched`] = D + off;
          c.stage.precise(sp, D + off, (now) => {
            plan.data[`${key}To`] = toFree(c, sp, now, [plan.data.xTo ?? 0, plan.data.yTo ?? 0]) ?? undefined;
          });
        }
      },
      ok(_c, plan, rec) {
        return plan.data.xTo !== undefined && plan.data.yTo !== undefined && rec.slips.get(plan.X!.pid)?.t === plan.data.xTo
          && rec.slips.get(plan.Y!.pid)?.t === plan.data.yTo && rec.pointBefore !== null && rec.pointAfter === null && !rec.sevenOut;
      },
      check(c, plan, P) {
        const rec = c.stage.rolls.get(plan.r)!;
        if (rec.sOut.h !== plan.X!.pid || rec.sOut.i !== 1) P.push(`both late roll ${plan.r}: the dice went to ${rec.sOut.h} (in play ${rec.sOut.i ?? 0}), not ${plan.X!.name}`);
        const { first, D } = firstOf(c, plan.r);
        const STAGGER = c.sim.pages[0].p.table.STAGGER_MS;
        if (!first || first.by === plan.X!.name || first.by === plan.Y!.name || D === undefined || first.at! < D + STAGGER) P.push(`both late roll ${plan.r}: the first close ${JSON.stringify(first)}, the closer's wait to ${D}`);
      },
    },
    edgeBefore: edgeCase(-200),
    edgeAfter: edgeCase(100),
  };
}

describe('computed craps: stands changed', () => {
  for (const n of SEEDS) {
    it(`stand-change ${n}: mid-hand, near the end of betting, back at the stand 0.2 s before the wait ends and 0.1 s after, the shooter and a bettor both late`, async () => {
      uiDom();
      try {
        // Four players at stands 3, 4, 2, 1; 5, 6 and 7 free. A's player is
        // named in markup.
        const sc: Scenario = {
          name: `stand-change ${n}`, label: 'craps-stands', seed: seed(4200 + n), markup: 0,
          pages: [pageAt('A', 3), pageAt('B', 4), pageAt('C', 2), pageAt('D', 1)],
          cases: standCases(),
          fill: (c, plan) => fillToPoint(c, plan, false),
        };
        const r = await play(sc);
        held(sc, r);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});

// ── 🛬 A throw after the close ───────────────────────────────────────────────

/** The clocks: up to 3 s apart. */
const SKEWS = [-1_500, 1_500, 300, -700];

function lateCases(): Record<string, Case> {
  /** The page that writes the fakes: the last one that isn't the holder. */
  const faker = (c: Run, X: SimPage): SimPage => [...c.sim.pages].reverse().find((q) => q !== X)!;
  const seeds = (c: Run, sp: SimPage, r: number): (number | null)[] => c.stage.throwsOf(sp, r).map((f) => seedOf(f.entry));
  const tosses = (c: Run, sp: SimPage, r: number): boolean => {
    const fl = c.stage.throwsOf(sp, r);
    return fl.length === 1 && seedOf(fl[0].entry) === fl[0].toss;
  };
  return {
    // The holder back at their stand in the wait's last 1.5 s, throwing at
    // once, over links that take 3.2-3.4 s out of their page: their page
    // gives its turn away (a change within STAGGER_MS of D), another closes
    // from D + 1.5 s, and the throw lands on every other page after the
    // close it saw. Each page one flight: the holder's own fling on theirs,
    // the stickman's toss of that close on the others (design E driveCraps:
    // a throw no later than the first close, else the toss). The last page
    // in the close turns (Y) runs no frame from 1 s past its wait's end for
    // 3.5 s (no wake: under a lapse), so both the close and the late throw
    // are in when its dice next move: its arrival stamps choose the toss.
    pushed: {
      ready: (c, K) => inPlayRiding(c, K) !== null,
      setup(c, plan) {
        const X = plan.X = inPlayRiding(c, plan.K)!;
        c.stage.move(X, 'off', c.sim.enter(X));
        plan.throwOff = null;
        plan.data.off = between(c.sim.rand, 300, 1_200);
        plan.sum = keepSum(c.sim.rand, plan.K.p);
        const ref = c.stage.ref()!;
        const ctx = c.sim.ctxOf(T, ref.p.casino.computedIncOf(T)!);
        const rank = (q: SimPage): string => ref.p.fold.dutyRank('close', ctx, plan.r, q.p.pub);
        const Y = plan.Y = c.sim.pages.filter((q) => q !== X).sort((a, b) => (rank(a) < rank(b) ? 1 : -1))[0];
        c.stage.pre.set(Y, (now) => {
          const v = Y.p.table.readComputedCraps(T, now);
          const D = c.stage.D(Y, plan.r);
          if (plan.data.lagUntil === undefined && D !== undefined && v?.round === plan.r && now >= D + 1_000) plan.data.lagUntil = now + 3_500;
          return plan.data.lagUntil === undefined || now >= plan.data.lagUntil;
        });
      },
      each(c, plan, sp, v) {
        const X = plan.X!;
        if (sp !== X) noteLate(plan, sp, X.pid);
        const D = waitEnd(plan, v);
        if (sp !== X || D === null || plan.data.at !== undefined) return;
        plan.data.at = D - plan.data.off!;
        c.stage.precise(X, D - plan.data.off!, (now) => {
          for (const q of c.sim.pages) if (q !== X) c.sim.net.setLink(X, q, { delay: [3_200, 3_400] });
          c.stage.move(X, c.home.get(X)!, now);
          if (c.stage.throwVia(X, 'key')) plan.data.thrown = now;
        });
      },
      ok: (_c, plan) => plan.data.thrown !== undefined,
      then(c) {
        c.sim.net.reset();
        for (const q of c.sim.pages) toHome(c, q);
      },
      check(c, plan, P) {
        const X = plan.X!;
        const r = plan.r;
        const own = c.stage.flung.get(`${X.name}|${r}`);
        const { first } = firstOf(c, r);
        if (!first || first.by === X.name) P.push(`throw after the close roll ${r}: the first close ${JSON.stringify(first)} is the holder's`);
        if (JSON.stringify(seeds(c, X, r)) !== JSON.stringify([own])) P.push(`throw after the close roll ${r}: ${X.name} flew ${JSON.stringify(seeds(c, X, r))}, its own fling ${own}`);
        for (const q of c.sim.pages.filter((x) => x !== X)) {
          if (plan.data[`late:${q.name}`] !== 1) P.push(`throw after the close roll ${r}: on ${q.name} the throw didn't come after the close (${plan.data[`late:${q.name}`]})`);
          else c.tally.lateThrows = (c.tally.lateThrows ?? 0) + 1;
          if (!tosses(c, q, r)) P.push(`throw after the close roll ${r}: ${q.name} flew ${JSON.stringify(c.stage.throwsOf(q, r))}, not the toss of its close`);
        }
        // The lagging page's first frame back saw both: its flight began then.
        const Y = plan.Y!;
        const fl = c.stage.throwsOf(Y, r);
        if (plan.data.lagUntil === undefined || fl.length !== 1 || fl[0].T < plan.data.lagUntil - Y.p.skew - c.sim.T + c.sim.elapsed - 1) {
          P.push(`throw after the close roll ${r}: ${Y.name} lagged ${plan.data.lagUntil} and flew ${JSON.stringify(fl)}`);
        } else c.tally.lagged = (c.tally.lagged ?? 0) + 1;
      },
    },
    // A fake during betting, in the holder's name: every other page flies
    // it when the wait starts (a throw by the holder, after the show, no
    // later than the close), and nothing else; the holder throws and closes.
    fakeBetting: {
      ready: (c, K) => inPlay(c, K) !== null,
      setup(c, plan) {
        plan.X = inPlay(c, plan.K)!;
        plan.Y = faker(c, plan.X);
        plan.throwOff = between(c.sim.rand, 2_000, 8_000);
        plan.data.fakeOff = between(c.sim.rand, 2_000, 9_000);
        plan.sum = keepSum(c.sim.rand, plan.K.p);
      },
      each(_c, plan, sp, v, now) {
        const W = betEnd(plan, v);
        if (sp !== plan.Y || W === null || plan.data.fakeT !== undefined || now < W - 16_000 + plan.data.fakeOff!) return;
        fakeThrow(sp, plan.r, plan.X!.pid, FAKE + plan.r);
        plan.data.fakeT = now;
      },
      ok: (c, plan) => plan.data.fakeT !== undefined && c.stage.flung.has(`${plan.X!.name}|${plan.r}`),
      check(c, plan, P) {
        const X = plan.X!;
        const r = plan.r;
        const own = c.stage.flung.get(`${X.name}|${r}`);
        if (JSON.stringify(seeds(c, X, r)) !== JSON.stringify([own])) P.push(`fake in betting roll ${r}: ${X.name} flew ${JSON.stringify(seeds(c, X, r))}, its own ${own}`);
        for (const q of c.sim.pages.filter((x) => x !== X)) {
          if (JSON.stringify(seeds(c, q, r)) !== JSON.stringify([FAKE + r])) P.push(`fake in betting roll ${r}: ${q.name} flew ${JSON.stringify(seeds(c, q, r))}, the fake ${FAKE + r}`);
        }
        const { first, D } = firstOf(c, r);
        if (!first || first.by !== X.name || D === undefined || first.at! >= D) P.push(`fake in betting roll ${r}: the first close ${JSON.stringify(first)} isn't the holder's fling`);
      },
    },
    // A fake for the roll written during the show of the one before: before
    // the roll's show ended, so it never flies. The holder doesn't throw
    // (TIME'S UP); every page flies the stickman's toss at the close.
    fakeShow: {
      ready: (c, K) => inPlay(c, K) !== null,
      setup(c, plan) {
        plan.X = inPlay(c, plan.K)!;
        plan.Y = faker(c, plan.X);
        plan.throwOff = null;
        plan.sum = keepSum(c.sim.rand, plan.K.p);
      },
      each(_c, plan, sp, v, now) {
        if (sp !== plan.Y || plan.data.fakeT !== undefined || v.round !== plan.r - 1 || v.phase !== 'settled' || v.rollKey === '') return;
        fakeThrow(sp, plan.r, plan.X!.pid, FAKE + plan.r);
        plan.data.fakeT = now;
      },
      ok: (c, plan) => plan.data.fakeT !== undefined && !c.stage.flung.has(`${plan.X!.name}|${plan.r}`),
      check(c, plan, P) {
        const X = plan.X!;
        const r = plan.r;
        for (const q of c.sim.pages) if (!tosses(c, q, r)) P.push(`fake in the show roll ${r}: ${q.name} flew ${JSON.stringify(c.stage.throwsOf(q, r))}, not the toss`);
        const xs = c.stage.lines(X, r);
        const offer = xs.findIndex((t) => t.startsWith('🎲 YOUR ROLL'));
        const up = xs.findIndex((t) => t.startsWith("✋ TIME'S UP — THE STICKMAN THREW"));
        if (offer < 0 || up < offer) P.push(`fake in the show roll ${r}: ${X.name} read ${JSON.stringify(xs)}`);
        const { first, D } = firstOf(c, r);
        if (!first || D === undefined || first.at! < D) P.push(`fake in the show roll ${r}: closed ${JSON.stringify(first)} before the wait ended (${D})`);
      },
    },
    // A fake written once its page saw the close: it lands after the close
    // everywhere and never flies; every other page flew the holder's throw.
    fakeAfterClose: {
      ready: (c, K) => inPlay(c, K) !== null,
      setup(c, plan) {
        plan.X = inPlay(c, plan.K)!;
        plan.Y = faker(c, plan.X);
        plan.throwOff = between(c.sim.rand, 2_000, 6_000);
        plan.sum = keepSum(c.sim.rand, plan.K.p);
      },
      each(_c, plan, sp, v, now) {
        const X = plan.X!;
        if (plan.data.fakeT !== undefined && sp !== X) noteLate(plan, sp, X.pid, 'fake');
        if (sp !== plan.Y || plan.data.fakeT !== undefined || v.round !== plan.r || sp.p.table.computedCrapsClose(T, plan.r) === null) return;
        fakeThrow(sp, plan.r, X.pid, FAKE + plan.r);
        plan.data.fakeT = now;
      },
      ok: (c, plan) => plan.data.fakeT !== undefined && c.stage.flung.has(`${plan.X!.name}|${plan.r}`),
      check(c, plan, P) {
        const X = plan.X!;
        const r = plan.r;
        const own = c.stage.flung.get(`${X.name}|${r}`);
        for (const q of c.sim.pages) {
          if (JSON.stringify(seeds(c, q, r)) !== JSON.stringify([own])) P.push(`fake after the close roll ${r}: ${q.name} flew ${JSON.stringify(seeds(c, q, r))}, the holder's ${own}`);
          if (q !== X && plan.data[`fake:${q.name}`] === 1) c.tally.lateFakes = (c.tally.lateFakes ?? 0) + 1;
        }
      },
    },
    // A throw in another player's name during the wait: not the holder's,
    // never flies; every other page flew the holder's own throw.
    fakeOther: {
      ready: (c, K) => inPlay(c, K) !== null,
      setup(c, plan) {
        plan.X = inPlay(c, plan.K)!;
        plan.Y = faker(c, plan.X);
        plan.throwOff = between(c.sim.rand, 7_000, 12_000);
        plan.data.fakeOff = between(c.sim.rand, 1_000, 4_000);
        plan.sum = keepSum(c.sim.rand, plan.K.p);
      },
      each(c, plan, sp, v, now) {
        const D = waitEnd(plan, v);
        if (sp !== plan.Y || plan.data.fakeT !== undefined || D === null || now < D - c.stage.SHOOTER_MS + plan.data.fakeOff!) return;
        fakeThrow(sp, plan.r, sp.pid, FAKE + plan.r);
        plan.data.fakeT = now;
      },
      ok: (c, plan) => plan.data.fakeT !== undefined && c.stage.flung.has(`${plan.X!.name}|${plan.r}`),
      check(c, plan, P) {
        const own = c.stage.flung.get(`${plan.X!.name}|${plan.r}`);
        for (const q of c.sim.pages) {
          if (JSON.stringify(seeds(c, q, plan.r)) !== JSON.stringify([own])) P.push(`another's throw roll ${plan.r}: ${q.name} flew ${JSON.stringify(seeds(c, q, plan.r))}, the holder's ${own}`);
        }
      },
    },
  };
}

describe('computed craps: a throw after the close', () => {
  for (const n of SEEDS) {
    it(`throw-after-close ${n}: clocks 3 s apart, a throw landing after another page's close, fakes before, after and beside it; one flight a roll on every page`, async () => {
      uiDom();
      try {
        // H at stand 3 (the ring's first: the dice come to them first) and
        // kept the holder; H's player is named in markup. The clocks run
        // 3 s apart, a different page ahead each seed.
        const skew = (i: number): number => SKEWS[(i + n) % SKEWS.length];
        const sc: Scenario = {
          name: `throw-after-close ${n}`, label: 'craps-late-throw', seed: seed(4300 + n), markup: 0,
          pages: [pageAt('H', 3, { skew: skew(0) }), pageAt('A', 4, { skew: skew(1) }), pageAt('B', 2, { skew: skew(2) }), pageAt('F', 1, { skew: skew(3) })],
          cases: lateCases(),
          fill(c, plan) {
            const K = plan.K;
            const H = c.sim.pages[0];
            plan.sum = K.h === H.pid || K.h === undefined ? keepSum(c.sim.rand, K.p) : K.p === 0 ? pick(c.sim.rand, POINTS) : 7;
          },
        };
        const r = await play(sc);
        held(sc, r);
        expect(r.c.tally.lateThrows ?? 0, r.c.sim.label).toBeGreaterThanOrEqual(3);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});

// ── ✏️ A roll shown, then rewritten ──────────────────────────────────────────

/**
 * Rolls decided by every seed are decided again by a forfeit counting only
 * X's (a valid forfeit beats the reveals: design lever 2, X's seed revealed
 * and X in its count), rigged so X's seed alone throws other dice
 * (rigSplit). On a roll whose forfeit turns X ranks first nobody answers
 * (answerDuty answers only a forfeit whose writer ranks after the page):
 * - written while the roll is on screen ('shown'): every page says
 *   `ROLL n WAS REWRITTEN — NEW DICE`;
 * - written once the roll after it is shown ('earlier'): `ROLL n CHANGED —
 *   …` (the rolls after it keep their dice and play again, design "Things
 *   players may notice").
 * On one where X doesn't rank first ('answered'), a page whose seed the
 * forfeit dropped answers it with the full count, which ranks first: the
 * roll ends decided on every seed's dice again (design: "answered maybe by
 * a page that saw the seed in time"). The notice oracle (Stage notices)
 * holds every page's notices to what its own screen showed change, frame
 * by frame, and the ⚙ card names the forfeit's writer, in markup, escaped.
 */
function rewriteCases(): { cases: Record<string, Case>; each: NonNullable<Scenario['each']> } {
  const XI = 3;
  const forfeits: { plan: Plan; when: 'shown' | 'next'; at?: number; wrote?: number }[] = [];
  const split = (c: Run, plan: Plan, when: 'shown' | 'next'): void => {
    const X = plan.X = c.sim.pages[XI];
    const both = pick(c.sim.rand, NON7);
    plan.sum = both;
    plan.split = { w: X, alone: pick(c.sim.rand, NON7.filter((s) => s !== both)) };
    forfeits.push({ plan, when });
  };
  const rewritten = (c: Run, plan: Plan, P: string[], what: string): void => {
    const vs = c.stage.versions.filter((x) => x.r === plan.r);
    if (!vs.some((x) => x.decided === 'forfeit' && x.sum === plan.split!.alone)) P.push(`${what} roll ${plan.r}: never decided by X's seed alone (${plan.split!.alone}): ${JSON.stringify(vs.map((x) => `${x.decided} ${x.sum}`))}`);
    c.tally[`${what}Versions`] = vs.length;
  };
  const ok = (c: Run, plan: Plan, rec: RollRec): boolean => rec.sum === plan.sum && rec.decided === 'reveals' && rec.counted.includes(c.sim.pages[XI].pid);
  /** Whether X's forfeit of roll r ranks first (every page bets). */
  const xFirst = (c: Run, r: number): boolean => {
    const ref = c.stage.ref();
    const inc = ref?.p.casino.computedIncOf(T);
    if (!ref || !inc) return false;
    const ctx = c.sim.ctxOf(T, inc);
    const rank = (q: SimPage): string => ref.p.fold.dutyRank('forfeit', ctx, r, q.p.pub);
    const X = c.sim.pages[XI];
    return c.sim.pages.every((q) => q === X || rank(X) < rank(q));
  };
  const cases: Record<string, Case> = {
    shown: {
      ready: (c, K, r) => K.h !== undefined && xFirst(c, r),
      setup: (c, plan) => split(c, plan, 'shown'),
      ok,
      check(c, plan, P) {
        rewritten(c, plan, P, 'shown');
        const last = c.stage.rolls.get(plan.r)!;
        if (last.sum !== plan.split!.alone) P.push(`shown roll ${plan.r}: ended on ${last.sum}, not X's seed alone (${plan.split!.alone}): nobody ranks before X to answer`);
      },
    },
    earlier: {
      ready: (c, K, r) => K.h !== undefined && c.done.shown !== undefined && xFirst(c, r),
      setup: (c, plan) => split(c, plan, 'next'),
      ok,
      check(c, plan, P) {
        rewritten(c, plan, P, 'earlier');
        const last = c.stage.rolls.get(plan.r)!;
        if (last.sum !== plan.split!.alone) P.push(`earlier roll ${plan.r}: ended on ${last.sum}, not X's seed alone (${plan.split!.alone})`);
      },
    },
    answered: {
      ready: (c, K, r) => K.h !== undefined && c.done.earlier !== undefined && !xFirst(c, r),
      setup: (c, plan) => split(c, plan, 'shown'),
      ok,
      check(c, plan, P) {
        const last = c.stage.rolls.get(plan.r)!;
        if (last.decided !== 'forfeit' || last.counted.length !== c.sim.pages.length || last.sum !== plan.sum) {
          P.push(`answered roll ${plan.r}: ended ${last.decided} on ${last.sum} counting ${JSON.stringify(last.counted)}, not an answer counting every seed (${plan.sum})`);
        }
      },
    },
    // (The markup player holds the dice: the lines naming them.)
    xHolds: {
      ready: (c, K) => K.h === c.sim.pages[XI].pid,
      setup(c, plan) {
        plan.X = c.sim.pages[XI];
        plan.sum = keepSum(c.sim.rand, plan.K.p);
      },
      ok: () => true,
      check() {},
    },
  };
  const each = (c: Run, _plan: Plan, sp: SimPage, v: ComputedCrapsState, now: number): void => {
    const X = c.sim.pages[XI];
    if (sp === X) {
      for (const f of forfeits) {
        if (f.wrote !== undefined) continue;
        const r = f.plan.r;
        const on = f.when === 'shown' ? r : r + 1;
        if (f.at === undefined && v.round === on && v.phase === 'settled' && v.rollKey.startsWith(`${on}:`)) f.at = now + between(c.sim.rand, 500, 2_000);
        if (f.at === undefined || now < f.at) continue;
        const inc = X.p.casino.computedIncOf(T)!;
        const rv = X.p.casino.computedFoldOf(T)?.rounds.find((x) => x.r === r);
        if (!rv || rv.decided !== 'reveals' || !rv.revealed.includes(X.pid)) continue;
        const rec = signAs(X.p, 'forfeit', { r, x: rv.close, n: [X.pid] }, c.sim.ctxOf(T, inc)) as unknown as ForfeitRec;
        putIn(X.p, [[X.p.fold.forfeitKey(rec)!, rec]], T);
        f.wrote = now;
        c.tally.forfeits = (c.tally.forfeits ?? 0) + 1;
      }
    } else if (c.tally.forfeitCard === undefined && c.stage.ui.has(sp)) {
      const chk = sp.p.table.computedRoundCheck(T, now);
      if (chk && chk.decided === 'forfeit' && chk.forfeitBy === X.pid) {
        const was = c.stage.cards;
        cardCheck(c.stage, sp, `DECIDED BY A FORFEIT BY ${MARKUP_ESC}`);
        if (c.stage.cards > was) c.tally.forfeitCard = 1;
      }
    }
  };
  return { cases, each };
}

describe('computed craps: a roll rewritten', () => {
  for (const n of SEEDS) {
    it(`rewrite ${n}: a roll on screen rewritten and an earlier one changed, each page's notices as its screen changed; names in markup shown as text`, async () => {
      uiDom();
      try {
        // X at stand 1 (the ring's last) writes the forfeits; its player is
        // named in markup. Every hand two rolls (a point, then a seven-out)
        // so the dice come round to X.
        const { cases, each } = rewriteCases();
        const sc: Scenario = {
          name: `rewrite ${n}`, label: 'craps-rewrite', seed: seed(4400 + n), markup: 3, notices: true,
          pages: [pageAt('A', 3), pageAt('B', 4), pageAt('C', 2), pageAt('X', 1)],
          cases, each,
          start: (c) => { c.sim.pages[3].cheats = true; },
          fill(c, plan) {
            plan.sum = plan.K.p === 0 ? pick(c.sim.rand, POINTS) : 7;
          },
          // A forfeit beats the reveals every page showed (lever 2), an
          // answer may beat it back, and the rolls after an earlier one
          // changed play again on their dice.
          finish: { flips: ['forfeit over reveals', 'answer forfeit', 'repaid'] },
          flights: (c, _sp, r) => c.stage.versions.filter((x) => x.r === r).length - 1,
        };
        const r = await play(sc);
        held(sc, r);
        expect(r.c.stage.rewritten, r.c.sim.label).toBeGreaterThan(0);
        expect(r.c.stage.changed, r.c.sim.label).toBeGreaterThan(0);
        expect(r.c.tally.forfeitCard ?? 0, r.c.sim.label).toBe(1);
      } finally {
        noDom();
      }
    }, TIMEOUT);
  }
});
