/**
 * 🧪🎰 SPIKE simulation — do computed tables (computedTableSpike.ts) hold up
 * with no operator? Several pages, each with its own Yjs doc, talk over a
 * simulated network (random delay, drops, splits, pages leaving and coming
 * back). Every page runs the same small policy: bet sometimes, close when its
 * own window runs out, reveal, write a forfeit when reveals are late. Then we
 * check that every page ends up with the same rounds and balances, chips are
 * conserved, nobody goes negative, and the tables kept moving.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import {
  canon, fold, forfeitRank, hashOf, newIdentity, seedCommit, sign, Verifier,
} from './computedTableSpike';
import type { CageRec, CloseRec, FoldOut, ForfeitRec, Game, Identity, RevealRec, SlipRec } from './computedTableSpike';
import type { CrapsBet } from './games/craps';
import type { RouletteBet } from './games/roulette';

const TABLES: { id: string; game: Game }[] = [
  { id: 'roul', game: 'roulette' },
  { id: 'craps', game: 'craps' },
];
const WINDOW_MS: Record<Game, number> = { roulette: 18_000, craps: 16_000 };
const GRACE_MS = 4_000;
const SHOW_MS = 6_000;
const TICK_MS = 250;
const STAGGER_MS = Number(process.env.SPIKE_STAGGER_MS ?? 1500);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Behaviour {
  /** chance per tick of betting once the window is open */
  betP: number;
  /** chance of holding back a reveal for a round */
  withholdP: number;
  /** writes a forfeit as soon as it sees a close, dropping everyone else */
  dropper: boolean;
  /** holds its reveal back, then after the grace reveals and writes its own forfeit counting itself */
  lateRevealer: boolean;
}

class Peer {
  doc = new Y.Doc();
  map = this.doc.getMap<unknown>('cc');
  verifier = new Verifier();
  online = true;
  atTable = new Set<string>(TABLES.map((t) => t.id));
  seq = 0;
  seeds = new Map<string, string>();
  withheld = new Set<string>();
  slipped = new Map<string, SlipRec>();
  firstSlipSeen = new Map<string, number>();
  closeSeen = new Map<string, number>();
  decidedSeen = new Map<string, number>();
  forfeited = new Set<string>();
  closed = new Set<string>();
  shown = new Map<string, string>();
  revealAt = new Map<string, number>();
  flips = 0;
  lastFold: FoldOut | null = null;
  foldMs = 0;
  folds = 0;
  constructor(public id: Identity, public skew: number, public drift: number, public b: Behaviour, public rand: () => number) {}
  local(t: number): number { return t * (1 + this.drift) + this.skew; }
  put(key: string, value: unknown): void { this.map.set(key, value); }
}

class Net {
  queue: { at: number; to: Peer; update: Uint8Array }[] = [];
  split: ((a: Peer, b: Peer) => boolean) | null = null;
  sent = 0;
  constructor(public peers: Peer[], public rand: () => number, public latency: [number, number], public dropP = 0) {
    for (const p of peers) {
      p.doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === 'net') return;
        for (const q of this.peers) {
          if (q === p || !this.linked(p, q)) continue;
          if (this.rand() < this.dropP) continue;
          const [lo, hi] = this.latency;
          this.queue.push({ at: this.now + lo + this.rand() * (hi - lo), to: q, update });
          this.sent++;
        }
      });
    }
  }
  now = 0;
  linked(a: Peer, b: Peer): boolean { return a.online && b.online && !(this.split?.(a, b) ?? false); }
  deliver(now: number): void {
    this.now = now;
    const due = this.queue.filter((m) => m.at <= now);
    this.queue = this.queue.filter((m) => m.at > now);
    for (const m of due) if (m.to.online) Y.applyUpdate(m.to.doc, m.update, 'net');
  }
  /** Anti-entropy, like the sync step on (re)connect: linked pages swap what the other lacks. */
  resync(): void {
    for (const a of this.peers) for (const b of this.peers) {
      if (a === b || !this.linked(a, b)) continue;
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), 'net');
    }
  }
}

function slipsFor(p: Peer, table: string, round: number): Map<string, { key: string; rec: SlipRec }> {
  const best = new Map<string, { key: string; rec: SlipRec }>();
  const prefix = `slip:${table}:${round}:`;
  for (const [k, v] of p.map.entries()) {
    if (!k.startsWith(prefix)) continue;
    const s = v as SlipRec;
    const cur = best.get(s.pid);
    if (!cur || s.seq > cur.rec.seq) best.set(s.pid, { key: k, rec: s });
  }
  return best;
}

function randomBets(p: Peer, game: Game, point: number | null, budget: number): (RouletteBet | CrapsBet)[] {
  const r = p.rand;
  const amount = Math.max(1, Math.min(budget, 1 + Math.floor(r() * 25)));
  if (budget < 1) return [];
  if (game === 'roulette') {
    const pick = r();
    if (pick < 0.4) return [{ type: r() < 0.5 ? 'red' : 'black', amount }];
    if (pick < 0.7) return [{ type: 'dozen', pick: Math.floor(r() * 3), amount }];
    return [{ type: 'straight', pick: Math.floor(r() * 37), amount }];
  }
  if (point === null) return [{ type: r() < 0.8 ? 'pass' : 'field', amount }];
  const pick = r();
  if (pick < 0.5) return [{ type: 'place', pick: r() < 0.5 ? 6 : 8, amount }];
  return [{ type: 'field', amount }];
}

function tickPeer(p: Peer, now: number): void {
  const L = p.local(now);
  const t0 = performance.now();
  const out = fold(p.map.entries(), TABLES, p.verifier);
  p.foldMs += performance.now() - t0;
  p.folds++;
  p.lastFold = out;
  const me = p.id.pid;
  for (const k of p.map.keys()) if (k.startsWith('reveal:') && !p.revealAt.has(k)) p.revealAt.set(k, L);
  // Reveals this page saw before its grace ran out for that close.
  const onTime = (rk: string, close: string, pid: string): boolean => {
    const at = p.revealAt.get(`reveal:${rk}:${pid}`);
    const c = p.closeSeen.get(close);
    return at !== undefined && c !== undefined && at <= c + GRACE_MS;
  };
  const rankOf = (pids: string[], tid: string, round: number): number =>
    [...new Set([...pids, me])].sort((a, b) => (forfeitRank(a, tid, round) < forfeitRank(b, tid, round) ? -1 : 1)).indexOf(me);

  // What this page has shown so far: a decided round that later reads
  // differently (or vanishes) is a flip the player would have seen.
  const seenNow = new Set<string>();
  for (const t of TABLES) {
    for (const r of out.tables[t.id].rounds) {
      if (!r.decided) continue;
      const k = `${t.id}:${r.round}`;
      // A result that rests on a forfeit isn't shown until the grace (+1 s
      // for the honest forfeits to arrive) has passed since the close.
      const closeAt = p.closeSeen.get(r.close);
      if (r.counted.length < r.frozen.length && (closeAt === undefined || L < closeAt + GRACE_MS + 1000)) {
        if (p.shown.has(k)) seenNow.add(k);
        continue;
      }
      seenNow.add(k);
      // What the player sees: who counted, the number, the payouts (a rival
      // close that froze the same slips reads the same).
      const v = canon({ n: r.counted, r: r.result, p: r.payouts });
      const prev = p.shown.get(k);
      if (prev !== undefined && prev !== v) { p.flips++; if (process.env.SPIKE_DEBUG) console.log(`FLIP ${me} ${k} ${prev} -> ${v}`); }
      p.shown.set(k, v);
      if (!p.decidedSeen.has(`${k}:${r.close}`)) p.decidedSeen.set(`${k}:${r.close}`, L);
    }
  }
  for (const k of [...p.shown.keys()]) if (!seenNow.has(k)) { p.flips++; if (process.env.SPIKE_DEBUG) console.log(`GONE ${me} ${k}`); p.shown.delete(k); }

  // Keep a little in the tray.
  const bal = out.balances[me] ?? 0;
  if (bal < 30 && p.b.betP > 0) {
    const rec = sign<CageRec>(p.id, { kind: 'cage', pid: me, seq: p.seq++, amount: 200 });
    p.put(`cage:${me}:${rec.seq}`, rec);
  }

  for (const t of TABLES) {
    if (!p.atTable.has(t.id)) continue;
    const rounds = out.tables[t.id].rounds;
    const last = rounds.at(-1);
    if (last) {
      // Reveal as soon as this page sees itself frozen, even if someone's
      // forfeit already makes the round look decided.
      const rk0 = `${t.id}:${last.round}`;
      const seed0 = p.seeds.get(rk0);
      if (!p.closeSeen.has(last.close)) p.closeSeen.set(last.close, L);
      const revealNow = (): void => p.put(`reveal:${rk0}:${me}`, sign<RevealRec>(p.id, { kind: 'reveal', table: t.id, round: last.round, pid: me, seed: seed0! }));
      if (last.frozen.includes(me) && seed0 && !p.map.has(`reveal:${rk0}:${me}`) && !p.withheld.has(rk0)) {
        if (p.b.lateRevealer || p.rand() < p.b.withholdP) p.withheld.add(rk0);
        else revealNow();
      }
      if (p.b.lateRevealer && p.withheld.has(rk0) && !p.map.has(`reveal:${rk0}:${me}`) && L >= p.closeSeen.get(last.close)! + GRACE_MS + 2000) {
        revealNow();
        const counted = last.frozen.filter((x) => p.map.has(`reveal:${rk0}:${x}`));
        const f: ForfeitRec = { kind: 'forfeit', table: t.id, round: last.round, close: last.close, counted, by: me };
        p.put(`forfeit:${rk0}:${hashOf(f)}`, f);
        p.forfeited.add(last.close);
      }
    }
    if (last && !last.decided) {
      // ── Closing: reveal, or forfeit the late ones after the grace.
      const ck = last.close;
      if (!p.closeSeen.has(ck)) p.closeSeen.set(ck, L);
      const rk = `${t.id}:${last.round}`;
      const dueAt = p.b.dropper ? p.closeSeen.get(ck)! : p.closeSeen.get(ck)! + GRACE_MS + rankOf(last.frozen, t.id, last.round) * STAGGER_MS;
      if (L >= dueAt && !p.forfeited.has(ck) && !p.b.lateRevealer) {
        p.forfeited.add(ck);
        const counted = p.b.dropper
          ? last.frozen.filter((x) => x === me && p.map.has(`reveal:${rk}:${me}`))
          : last.frozen.filter((x) => onTime(rk, ck, x));
        const f: ForfeitRec = { kind: 'forfeit', table: t.id, round: last.round, close: ck, counted, by: me };
        p.put(`forfeit:${rk}:${hashOf(f)}`, f);
      }
      continue;
    }

    // A round decided on someone's forfeit that left out reveals this page
    // holds: answer with this page's own forfeit (most reveals wins).
    if (last && last.decidedBy && last.counted.length < last.frozen.length && !p.forfeited.has(last.close) && !p.b.dropper && !p.b.lateRevealer
      && forfeitRank(me, t.id, last.round) < forfeitRank(last.decidedBy, t.id, last.round)) {
      const lk = `${t.id}:${last.round}`;
      const mine = last.frozen.filter((x) => onTime(lk, last.close, x));
      const closeAt = p.closeSeen.get(last.close) ?? L;
      if (mine.length > last.counted.length && L >= closeAt + GRACE_MS) {
        p.forfeited.add(last.close);
        const f: ForfeitRec = { kind: 'forfeit', table: t.id, round: last.round, close: last.close, counted: mine, by: me };
        p.put(`forfeit:${lk}:${hashOf(f)}`, f);
      }
    }

    // ── Betting for round R.
    const R = (last?.round ?? 0) + 1;
    const rk = `${t.id}:${R}`;
    // A decision that rests on a forfeit isn't acted on until the grace has
    // passed, so a reveal still in flight can win (most reveals wins).
    if (last) {
      const decidedAt = p.decidedSeen.get(`${t.id}:${last.round}:${last.close}`) ?? L;
      const onForfeit = last.counted.length < last.frozen.length;
      const closeAt = p.closeSeen.get(last.close) ?? decidedAt;
      if (L < decidedAt + SHOW_MS) continue;
      if (onForfeit && L < closeAt + GRACE_MS + 1000) continue;
    }
    const slips = slipsFor(p, t.id, R);
    if (slips.size && !p.firstSlipSeen.has(rk)) p.firstSlipSeen.set(rk, L);

    if (p.b.betP > 0 && !p.slipped.has(rk) && p.rand() < p.b.betP) {
      // Budget: worked-out balance minus my slips on rounds not closed yet.
      let pending = 0;
      for (const [k, s] of p.slipped) {
        const [tid, rs] = k.split(':');
        const rr = out.tables[tid].rounds;
        const closedHere = rr.some((x) => x.round === Number(rs));
        if (!closedHere) pending += s.bets.reduce((n, b) => n + b.amount, 0);
      }
      const bets = randomBets(p, t.game, out.tables[t.id].point, bal - pending);
      if (bets.length) {
        const seed = bytesToHex(randomBytes(16));
        p.seeds.set(rk, seed);
        const basis: Record<string, number> = {};
        for (const tt of TABLES) { const d = out.tables[tt.id].rounds.filter((x) => x.decided).at(-1); if (d) basis[tt.id] = d.round; }
        const rec = sign<SlipRec>(p.id, { kind: 'slip', table: t.id, round: R, pid: me, seq: p.seq++, bets, commit: seedCommit(seed, t.id, R, me), basis });
        p.slipped.set(rk, rec);
        p.put(`slip:${rk}:${me}:${hashOf(rec)}`, rec);
        if (!p.firstSlipSeen.has(rk)) p.firstSlipSeen.set(rk, L);
      }
    }

    const first = p.firstSlipSeen.get(rk);
    // Stagger: the pages in the round take turns by a per-round ranking
    // (hash of player and round). Rank 0 closes when its window ends, rank 1
    // STAGGER_MS later if no close has reached it, and so on.
    const inRound = new Set([me, ...slipsFor(p, t.id, R).keys()]);
    const rank = [...inRound].sort((a, b) => (hashOf([a, rk]) < hashOf([b, rk]) ? -1 : 1)).indexOf(me);
    const jitter = rank * STAGGER_MS;
    if (first !== undefined && L >= first + WINDOW_MS[t.game] + jitter && !p.closed.has(rk)) {
      p.closed.add(rk);
      const now2 = slipsFor(p, t.id, R);
      const close: CloseRec = {
        kind: 'close', table: t.id, round: R, prev: last?.close ?? 'genesis',
        slips: Object.fromEntries([...now2.values()].map((s) => [s.rec.pid, s.key.split(':').at(-1)!])),
        by: me,
      };
      p.put(`close:${rk}:${hashOf(close)}`, close);
    }
  }
}

interface Scenario {
  name: string;
  seed: number;
  players: number;
  minutes: number;
  latency: [number, number];
  dropP?: number;
  skewMs?: number;
  behaviour?: (i: number) => Partial<Behaviour>;
  events?: (t: number, net: Net, peers: Peer[]) => void;
}

interface Report {
  name: string;
  rounds: Record<string, number>;
  rivalCloses: number;
  voidedOnLosingBranch: number;
  forfeitRounds: number;
  rejected: number;
  leftOut: number;
  slips: number;
  flipsPerPeer: number[];
  docBytes: number;
  avgFoldMs: number;
  converged: boolean;
  conserved: boolean;
  noNegative: boolean;
  out: FoldOut;
}

function run(sc: Scenario): Report {
  const rand = rng(sc.seed);
  const peers: Peer[] = [];
  for (let i = 0; i < sc.players; i++) {
    const b: Behaviour = { betP: 0.08, withholdP: 0, dropper: false, lateRevealer: false, ...(sc.behaviour?.(i) ?? {}) };
    const skew = (rand() - 0.5) * 2 * (sc.skewMs ?? 5000);
    const drift = (rand() - 0.5) * 0.002; // ±0.1 % clock rate
    peers.push(new Peer(newIdentity(`p${i}`), skew, drift, b, rng(sc.seed * 31 + i)));
  }
  const net = new Net(peers, rand, sc.latency, sc.dropP ?? 0);
  for (const p of peers) {
    p.put(`key:${p.id.pid}`, p.id.pub);
    const rec = sign<CageRec>(p.id, { kind: 'cage', pid: p.id.pid, seq: p.seq++, amount: 500 });
    p.put(`cage:${p.id.pid}:${rec.seq}`, rec);
  }
  const end = sc.minutes * 60_000;
  for (let t = 0; t <= end; t += TICK_MS) {
    sc.events?.(t, net, peers);
    net.deliver(t);
    if (t % 5000 === 0) net.resync();
    for (const p of peers) if (p.online) tickPeer(p, t);
  }
  // Heal everything and let it settle (no new bets).
  net.split = null;
  for (const p of peers) { p.online = true; p.b.betP = 0; }
  for (let t = end; t <= end + 60_000; t += TICK_MS) {
    net.deliver(t);
    if (t % 5000 === 0) net.resync();
    for (const p of peers) tickPeer(p, t);
  }
  net.deliver(Infinity);
  net.resync();
  const outs = peers.map((p) => fold(p.map.entries(), TABLES, new Verifier()));
  const ref = canon(outs[0]);
  const converged = outs.every((o) => canon(o) === ref);
  const o = outs[0];
  const sumBal = Object.values(o.balances).reduce((a, b) => a + b, 0);
  const allCloses = [...peers[0].map.keys()].filter((k) => k.startsWith('close:'));
  const onChain = new Set(Object.values(o.tables).flatMap((t) => t.rounds.map((r) => `${t.id}:${r.close}`)));
  const offChain = allCloses.filter((k) => { const [, tid, , h] = k.split(':'); return !onChain.has(`${tid}:${h}`); });
  const closeHashes = new Set(Object.values(o.tables).flatMap((t) => t.rounds.map((r) => r.close)));
  // A losing-branch round: its close chained to a close that is itself off the chain.
  const voided = offChain.filter((k) => { const c = peers[0].map.get(k) as CloseRec; return c.prev !== 'genesis' && !closeHashes.has(c.prev); }).length;
  return {
    name: sc.name,
    rounds: Object.fromEntries(Object.values(o.tables).map((t) => [t.id, t.rounds.filter((r) => r.decided).length])),
    rivalCloses: offChain.length,
    voidedOnLosingBranch: voided,
    forfeitRounds: Object.values(o.tables).flatMap((t) => t.rounds).filter((r) => r.counted.length < r.frozen.length).length,
    rejected: o.rejected.length,
    leftOut: (() => {
      let n = 0;
      for (const t of Object.values(o.tables)) for (const r of t.rounds) {
        const writers = new Set([...peers[0].map.keys()].filter((k) => k.startsWith(`slip:${t.id}:${r.round}:`)).map((k) => k.split(':')[3]));
        for (const w of writers) if (!r.frozen.includes(w)) n++;
      }
      return n;
    })(),
    slips: [...peers[0].map.keys()].filter((k) => k.startsWith('slip:')).length,
    flipsPerPeer: peers.map((p) => p.flips),
    docBytes: Y.encodeStateAsUpdate(peers[0].doc).length,
    avgFoldMs: peers.reduce((a, p) => a + p.foldMs, 0) / peers.reduce((a, p) => a + p.folds, 0),
    converged,
    conserved: sumBal + o.houseNet === o.boughtIn,
    noNegative: Object.values(o.balances).every((b) => b >= 0),
    out: o,
  };
}

function show(r: Report): void {
  const { out: _o, ...rest } = r;
  console.log(`\n[${r.name}] ${JSON.stringify(rest)}`);
}

function basicChecks(r: Report): void {
  expect(r.converged).toBe(true);
  expect(r.conserved).toBe(true);
  expect(r.noNegative).toBe(true);
  for (const t of Object.values(r.out.tables)) {
    // every round but the last is decided, and the chain has no gaps
    t.rounds.forEach((x, i) => expect(x.round).toBe(i + 1));
    expect(t.rounds.slice(0, -1).every((x) => x.decided)).toBe(true);
  }
}

describe('computed tables spike (simulation)', () => {
  it('baseline: 6 players, ordinary latency, skewed clocks, no owner', () => {
    const r = run({ name: 'baseline', seed: 1, players: 6, minutes: 15, latency: [40, 300] });
    show(r);
    basicChecks(r);
    expect(r.rounds.roul).toBeGreaterThan(25);
    expect(r.rounds.craps).toBeGreaterThan(25);
  }, 300_000);

  it('slow network: 1-3 s delays, 5% of messages lost', () => {
    const r = run({ name: 'slow-net', seed: 2, players: 6, minutes: 15, latency: [1000, 3000], dropP: 0.05 });
    show(r);
    basicChecks(r);
    expect(r.rounds.roul).toBeGreaterThan(15);
  }, 300_000);

  it('network split for 3 minutes with players on both sides', () => {
    const r = run({
      name: 'split', seed: 3, players: 6, minutes: 12, latency: [40, 300],
      events: (t, net) => {
        if (t === 180_000) net.split = (a, b) => (Number(a.id.pid.slice(1)) < 3) !== (Number(b.id.pid.slice(1)) < 3);
        if (t === 360_000) net.split = null;
      },
    });
    show(r);
    basicChecks(r);
  }, 300_000);

  it('churn: players leave and come back, sometimes only one at the table', () => {
    const r = run({
      name: 'churn', seed: 4, players: 5, minutes: 15, latency: [40, 400],
      events: (t, _net, peers) => {
        if (t % 20_000 !== 0) return;
        const rr = rng(t);
        for (const p of peers) if (rr() < 0.25) p.online = !p.online;
        if (!peers.some((p) => p.online)) peers[0].online = true;
      },
    });
    show(r);
    basicChecks(r);
    expect(r.rounds.roul).toBeGreaterThan(10);
  }, 300_000);

  it('cheats: a withholder, a page that drops reveals from its forfeits', () => {
    const r = run({
      name: 'cheats', seed: 5, players: 6, minutes: 15, latency: [40, 300],
      behaviour: (i) => (i === 0 ? { withholdP: 0.3 } : i === 1 ? { dropper: true } : {}),
    });
    show(r);
    basicChecks(r);
    // The dropper's forfeit decides a round only when its page ranks first for
    // that round (about 1 in 6 here) or no lower-ranked honest page answered.
    const all = Object.values(r.out.tables).flatMap((t) => t.rounds);
    const dropperWins = all.filter((x) => x.frozen.length > 1 && x.counted.length <= 1 && x.counted.length < x.frozen.filter((p) => p !== 'p0').length).length;
    console.log(`[cheats] rounds decided by a dropper-sized forfeit: ${dropperWins} of ${all.length}`);
    expect(dropperWins).toBeLessThan(all.length / 2);
  }, 300_000);

  it('a late revealer: holds its seed back, then reveals after the grace with its own forfeit', () => {
    const r = run({
      name: 'late-revealer', seed: 6, players: 6, minutes: 15, latency: [40, 300],
      behaviour: (i) => (i === 0 ? { lateRevealer: true } : {}),
    });
    show(r);
    basicChecks(r);
    const all = Object.values(r.out.tables).flatMap((t) => t.rounds).filter((x) => x.frozen.includes('p0'));
    const gotIn = all.filter((x) => x.counted.includes('p0')).length;
    console.log(`[late-revealer] rounds where the late seed counted: ${gotIn} of ${all.length}`);
    expect(gotIn).toBeLessThan(all.length / 2);
  }, 300_000);

  it('forged and overspent slips are thrown out without touching anyone else', () => {
    const v = new Verifier();
    const alice = newIdentity('alice');
    const mallory = newIdentity('mallory');
    const m = new Map<string, unknown>();
    m.set('key:alice', alice.pub);
    m.set('key:mallory', mallory.pub);
    const cage = (id: Identity, seq: number, amount: number) => { const c = sign<CageRec>(id, { kind: 'cage', pid: id.pid, seq, amount }); m.set(`cage:${id.pid}:${seq}`, c); };
    cage(alice, 0, 100);
    cage(mallory, 0, 100);
    const seeds: Record<string, string> = { alice: 'a1', mallory: 'm1' };
    // Mallory signs a slip in Alice's name with her own key, and overspends at two tables.
    const forged = sign<SlipRec>(mallory, { kind: 'slip', table: 'roul', round: 1, pid: 'alice', seq: 1, bets: [{ type: 'red', amount: 100 }], commit: seedCommit('a1', 'roul', 1, 'alice'), basis: {} });
    const m1 = sign<SlipRec>(mallory, { kind: 'slip', table: 'roul', round: 1, pid: 'mallory', seq: 1, bets: [{ type: 'black', amount: 80 }], commit: seedCommit('m1', 'roul', 1, 'mallory'), basis: {} });
    const m2 = sign<SlipRec>(mallory, { kind: 'slip', table: 'craps', round: 1, pid: 'mallory', seq: 2, bets: [{ type: 'pass', amount: 80 }], commit: seedCommit('m2', 'craps', 1, 'mallory'), basis: {} });
    for (const s of [forged, m1, m2]) m.set(`slip:${s.table}:${s.round}:${s.pid}:${hashOf(s)}`, s);
    const c1: CloseRec = { kind: 'close', table: 'roul', round: 1, prev: 'genesis', slips: { alice: hashOf(forged), mallory: hashOf(m1) }, by: 'mallory' };
    const c2: CloseRec = { kind: 'close', table: 'craps', round: 1, prev: 'genesis', slips: { mallory: hashOf(m2) }, by: 'mallory' };
    m.set(`close:roul:1:${hashOf(c1)}`, c1);
    m.set(`close:craps:1:${hashOf(c2)}`, c2);
    m.set('reveal:roul:1:alice', sign<RevealRec>(mallory, { kind: 'reveal', table: 'roul', round: 1, pid: 'alice', seed: seeds.alice }));
    m.set('reveal:roul:1:mallory', sign<RevealRec>(mallory, { kind: 'reveal', table: 'roul', round: 1, pid: 'mallory', seed: 'm1' }));
    m.set('reveal:craps:1:mallory', sign<RevealRec>(mallory, { kind: 'reveal', table: 'craps', round: 1, pid: 'mallory', seed: 'm2' }));
    const f: ForfeitRec = { kind: 'forfeit', table: 'roul', round: 1, close: hashOf(c1), counted: ['mallory'], by: 'mallory' };
    m.set(`forfeit:roul:1:${hashOf(f)}`, f);
    const out = fold(m.entries(), TABLES, v);
    console.log(`\n[forgery] ${JSON.stringify({ balances: out.balances, rejected: out.rejected })}`);
    expect(out.balances.alice).toBe(100); // the forged slip never touched Alice
    expect(out.rejected).toContain('roul:1:alice');
    expect(out.rejected).toContain('craps:1:mallory'); // the second 80 overspends her 100
    expect(out.balances.mallory).toBeGreaterThanOrEqual(0);
    expect(Object.values(out.balances).reduce((a, b) => a + b, 0) + out.houseNet).toBe(out.boughtIn);
  });

  it('a long history: 5,000 roulette rounds, 5 players — doc size and fold time for a new page', () => {
    const ids = [0, 1, 2, 3, 4].map((i) => newIdentity(`h${i}`));
    const doc = new Y.Doc();
    const m = doc.getMap<unknown>('cc');
    const rand = rng(9);
    const ROUNDS = 5000;
    const t0 = performance.now();
    doc.transact(() => {
      for (const id of ids) { m.set(`key:${id.pid}`, id.pub); const c = sign<CageRec>(id, { kind: 'cage', pid: id.pid, seq: 0, amount: 1_000_000 }); m.set(`cage:${id.pid}:0`, c); }
      let prev = 'genesis';
      for (let r = 1; r <= ROUNDS; r++) {
        const slips: Record<string, string> = {};
        for (const id of ids) {
          const seed = `s${r}${id.pid}`;
          const s = sign<SlipRec>(id, { kind: 'slip', table: 'roul', round: r, pid: id.pid, seq: r, bets: [{ type: rand() < 0.5 ? 'red' : 'black', amount: 5 }], commit: seedCommit(seed, 'roul', r, id.pid), basis: {} });
          const h = hashOf(s);
          m.set(`slip:roul:${r}:${id.pid}:${h}`, s);
          slips[id.pid] = h;
          m.set(`reveal:roul:${r}:${id.pid}`, sign<RevealRec>(id, { kind: 'reveal', table: 'roul', round: r, pid: id.pid, seed }));
        }
        const c: CloseRec = { kind: 'close', table: 'roul', round: r, prev, slips, by: ids[r % 5].pid };
        prev = hashOf(c);
        m.set(`close:roul:${r}:${prev}`, c);
      }
    });
    const buildMs = performance.now() - t0;
    const bytes = Y.encodeStateAsUpdate(doc).length;
    const fresh = new Verifier();
    const a = performance.now();
    const out = fold(m.entries(), [{ id: 'roul', game: 'roulette' }], fresh);
    const coldMs = performance.now() - a;
    const b = performance.now();
    fold(m.entries(), [{ id: 'roul', game: 'roulette' }], fresh);
    const warmMs = performance.now() - b;
    console.log(`\n[history] ${JSON.stringify({ rounds: out.tables.roul.rounds.length, records: m.size, docBytes: bytes, bytesPerRound: Math.round(bytes / ROUNDS), signatureChecks: fresh.checks, coldFoldMs: Math.round(coldMs), warmFoldMs: Math.round(warmMs), buildMs: Math.round(buildMs) })}`);
    expect(out.tables.roul.rounds.length).toBe(ROUNDS);
    expect(out.tables.roul.rounds.every((x) => x.decided)).toBe(true);
  }, 600_000);
});
