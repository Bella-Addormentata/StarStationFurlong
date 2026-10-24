/**
 * 🧪🎰 SPIKE — computed casino tables (no operator). NOT wired into the game.
 *
 * The question this spike answers: can craps / roulette run with nobody in
 * charge — every page writes only its own signed records, any page may move a
 * round along, and every page folds the same records into the same results and
 * balances? See the "Computed casino tables: design" doc for the design; the
 * simulation that checks it is computedTableSpike.test.ts.
 *
 * RECORDS (one Y.Map, every key written once):
 *   key:<pid>                         → identity public key (first sight wins)
 *   cage:<pid>:<seq>                  → a signed buy-in
 *   slip:<table>:<round>:<pid>:<hash> → a signed bet slip (each version kept)
 *   close:<table>:<round>:<hash>      → "no more bets", by any page (rivals kept)
 *   reveal:<table>:<round>:<pid>      → a signed seed
 *   forfeit:<table>:<round>:<hash>    → which reveals counted, by any page
 *
 * Nothing pays anyone: payouts and balances are the fold's output.
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { resolveRound } from './games/roulette';
import type { RouletteBet } from './games/roulette';
import { canPlaceBet, nextPoint, resolveCrapsRound } from './games/craps';
import type { CrapsBet } from './games/craps';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export type Game = 'roulette' | 'craps';
export type AnyBet = RouletteBet | CrapsBet;

export interface CageRec { kind: 'cage'; pid: string; seq: number; amount: number; sig: string }
export interface SlipRec {
  kind: 'slip'; table: string; round: number; pid: string; seq: number;
  /** roulette: the round's whole felt; craps: NEW bets this roll (riding bets carry). */
  bets: AnyBet[];
  /** sha256 of this round's seed (same in every version of the player's slip). */
  commit: string;
  /** table → last decided round whose winnings this slip counted on. */
  basis: Record<string, number>;
  sig: string;
}
export interface CloseRec {
  kind: 'close'; table: string; round: number;
  /** hash of the previous round's chosen close ('genesis' for round 1). */
  prev: string;
  /** pid → hash of the slip version frozen. */
  slips: Record<string, string>;
  by: string;
}
export interface RevealRec { kind: 'reveal'; table: string; round: number; pid: string; seed: string; sig: string }
export interface ForfeitRec { kind: 'forfeit'; table: string; round: number; close: string; counted: string[]; by: string }

// ── Canonical bytes + hashes ─────────────────────────────────────────────────

/** JSON with sorted keys, so every page hashes the same bytes. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const hashCache = new WeakMap<object, string>();
/** Record hash (cached per object: a Y.Map hands back the same value object each read). */
export const hashOf = (v: unknown): string => {
  if (v && typeof v === 'object') {
    const hit = hashCache.get(v);
    if (hit) return hit;
    const h = bytesToHex(sha256(utf8ToBytes(canon(v)))).slice(0, 32);
    hashCache.set(v, h);
    return h;
  }
  return bytesToHex(sha256(utf8ToBytes(canon(v)))).slice(0, 32);
};
const unsigned = <T extends { sig: string }>(r: T): Omit<T, 'sig'> => { const { sig: _s, ...rest } = r; return rest; };
export const seedCommit = (seed: string, table: string, round: number, pid: string): string =>
  hashOf(['ssf-computed-seed-v1', seed, table, round, pid]);

// ── Signing ──────────────────────────────────────────────────────────────────

export interface Identity { pid: string; priv: Uint8Array; pub: string }
export function newIdentity(pid: string): Identity {
  const priv = ed.utils.randomPrivateKey();
  return { pid, priv, pub: bytesToHex(ed.getPublicKey(priv)) };
}
export function sign<T extends { sig: string }>(id: Identity, rec: Omit<T, 'sig'>): T {
  const sig = bytesToHex(ed.sign(utf8ToBytes(canon(rec)), id.priv));
  return { ...(rec as object), sig } as T;
}

/** Signature checks, cached per record (a page checks each record once). */
export class Verifier {
  private ok = new Map<string, boolean>();
  checks = 0;
  verify(pub: string | undefined, rec: { sig: string }): boolean {
    if (!pub || typeof rec.sig !== 'string') return false;
    const k = `${pub}|${rec.sig}`;
    const hit = this.ok.get(k);
    if (hit !== undefined) return hit;
    this.checks++;
    let good = false;
    try { good = ed.verify(hexToBytes(rec.sig), utf8ToBytes(canon(unsigned(rec))), hexToBytes(pub)); } catch { good = false; }
    this.ok.set(k, good);
    return good;
  }
}

// ── The fold ─────────────────────────────────────────────────────────────────

export interface RoundOut {
  round: number;
  close: string;
  decided: boolean;
  /** pids whose seeds counted (sorted); frozen pids missing from it forfeited. */
  counted: string[];
  /** who wrote the forfeit that decided it (null: every reveal came in). */
  decidedBy: string | null;
  /** pids whose slips the close froze (sorted). */
  frozen: string[];
  /** craps: the point in force when this roll's bets were placed. */
  pointBefore: number | null;
  /** roulette pocket or craps dice; null while pending or when nobody revealed. */
  result: number | [number, number] | null;
  /** pid → chips returned this round (stake included), accepted slips only. */
  payouts: Record<string, number>;
}
export interface TableOut { id: string; game: Game; rounds: RoundOut[]; /** craps: the point in force after the last decided roll. */ point: number | null }
export interface FoldOut {
  tables: Record<string, TableOut>;
  balances: Record<string, number>;
  /** slips frozen in a close but thrown out (bad signature, overspend, invalid bet). */
  rejected: string[];
  /** Σ frozen accepted stakes − Σ payouts: what the house is up. */
  houseNet: number;
  boughtIn: number;
}

interface Indexed {
  keys: Map<string, string>;
  cage: Map<string, CageRec[]>;
  slips: Map<string, SlipRec>; // by slip hash
  closes: Map<string, Map<number, { hash: string; rec: CloseRec }[]>>;
  reveals: Map<string, RevealRec>; // `${table}:${round}:${pid}`
  forfeits: Map<string, { hash: string; rec: ForfeitRec }[]>; // `${table}:${round}`
}

function index(entries: Iterable<[string, unknown]>, verifier: Verifier): Indexed {
  const ix: Indexed = { keys: new Map(), cage: new Map(), slips: new Map(), closes: new Map(), reveals: new Map(), forfeits: new Map() };
  const all = [...entries];
  for (const [k, v] of all) if (k.startsWith('key:') && typeof v === 'string') ix.keys.set(k.slice(4), v);
  for (const [k, v] of all) {
    const r = v as { kind?: string } | null;
    if (!r || typeof r !== 'object') continue;
    if (k.startsWith('cage:') && r.kind === 'cage') {
      const c = r as CageRec;
      if (k !== `cage:${c.pid}:${c.seq}` || !Number.isInteger(c.amount) || c.amount <= 0) continue;
      if (!verifier.verify(ix.keys.get(c.pid), c)) continue;
      const list = ix.cage.get(c.pid) ?? [];
      list.push(c);
      ix.cage.set(c.pid, list);
    } else if (k.startsWith('slip:') && r.kind === 'slip') {
      const s = r as SlipRec;
      const h = hashOf(s);
      if (k !== `slip:${s.table}:${s.round}:${s.pid}:${h}`) continue;
      ix.slips.set(h, s); // signature checked when a close freezes it
    } else if (k.startsWith('close:') && r.kind === 'close') {
      const c = r as CloseRec;
      const h = hashOf(c);
      if (k !== `close:${c.table}:${c.round}:${h}`) continue;
      const t = ix.closes.get(c.table) ?? new Map();
      const list = t.get(c.round) ?? [];
      list.push({ hash: h, rec: c });
      t.set(c.round, list);
      ix.closes.set(c.table, t);
    } else if (k.startsWith('reveal:') && r.kind === 'reveal') {
      const rv = r as RevealRec;
      if (k !== `reveal:${rv.table}:${rv.round}:${rv.pid}`) continue;
      if (!verifier.verify(ix.keys.get(rv.pid), rv)) continue;
      ix.reveals.set(`${rv.table}:${rv.round}:${rv.pid}`, rv);
    } else if (k.startsWith('forfeit:') && r.kind === 'forfeit') {
      const f = r as ForfeitRec;
      const h = hashOf(f);
      if (k !== `forfeit:${f.table}:${f.round}:${h}`) continue;
      const kk = `${f.table}:${f.round}`;
      const list = ix.forfeits.get(kk) ?? [];
      list.push({ hash: h, rec: f });
      ix.forfeits.set(kk, list);
    }
  }
  return ix;
}

/** The chosen chain of closes for one table: from round 1, at each round the
 *  candidate (chaining to the round before) with the longest chain after it,
 *  ties to the smallest hash. Every page picks the same one. */
export function chooseChain(byRound: Map<number, { hash: string; rec: CloseRec }[]> | undefined): { hash: string; rec: CloseRec }[] {
  if (!byRound) return [];
  const children = new Map<string, { hash: string; rec: CloseRec }[]>();
  for (const list of byRound.values()) {
    for (const c of list) {
      const key = `${c.rec.round - 1}:${c.rec.prev}`;
      const l = children.get(key) ?? [];
      l.push(c);
      children.set(key, l);
    }
  }
  const depth = new Map<string, number>();
  const depthOf = (c: { hash: string; rec: CloseRec }): number => {
    const memo = depth.get(c.hash);
    if (memo !== undefined) return memo;
    let best = 0;
    for (const ch of children.get(`${c.rec.round}:${c.hash}`) ?? []) best = Math.max(best, depthOf(ch));
    depth.set(c.hash, best + 1);
    return best + 1;
  };
  const chain: { hash: string; rec: CloseRec }[] = [];
  let key = '0:genesis';
  for (;;) {
    const cands = children.get(key);
    if (!cands?.length) break;
    const pick = [...cands].sort((a, b) => depthOf(b) - depthOf(a) || (a.hash < b.hash ? -1 : 1))[0];
    chain.push(pick);
    key = `${pick.rec.round}:${pick.hash}`;
  }
  return chain;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** A page's place in line for one round's duties (closing, forfeits): lowest first. */
export const forfeitRank = (pid: string, table: string, round: number): string => hashOf(['ssf-computed-rank-v1', pid, table, round]);

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Seeds → result. Roulette: pocket 0–36; craps: two dice. */
function resultFrom(game: Game, seeds: string[], table: string, round: number): number | [number, number] {
  const h = sha256(utf8ToBytes(canon(['ssf-computed-mix-v1', table, round, seeds])));
  if (game === 'roulette') return ((h[0] << 8) | h[1]) % 37;
  return [(h[0] % 6) + 1, (h[1] % 6) + 1];
}

export function fold(entries: Iterable<[string, unknown]>, tables: { id: string; game: Game }[], verifier: Verifier): FoldOut {
  const ix = index(entries, verifier);
  const out: FoldOut = { tables: {}, balances: {}, rejected: [], houseNet: 0, boughtIn: 0 };

  // 1) Each table's chain, which rounds are decided, and their results —
  //    independent of anyone's balance.
  interface RoundWork { out: RoundOut; frozen: Map<string, SlipRec> }
  const work = new Map<string, RoundWork[]>();
  for (const t of tables) {
    const chain = chooseChain(ix.closes.get(t.id));
    const rounds: RoundWork[] = [];
    let tablePoint: number | null = null;
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      const frozen = new Map<string, SlipRec>();
      let missing = false;
      for (const [pid, sh] of Object.entries(c.rec.slips)) {
        const s = ix.slips.get(sh);
        if (!s) { missing = true; continue; }
        if (s.pid !== pid || s.table !== t.id || s.round !== c.rec.round) continue;
        frozen.set(pid, s);
      }
      const frozenPids = [...frozen.keys()].sort();
      const revealed = (pid: string): boolean => {
        const rv = ix.reveals.get(`${t.id}:${c.rec.round}:${pid}`);
        const s = frozen.get(pid);
        return !!rv && !!s && seedCommit(rv.seed, t.id, c.rec.round, pid) === s.commit;
      };
      // Decided by: the forfeit whose writer ranks first for this round
      // (forfeitRank), if any is valid; else every frozen reveal being in.
      let counted: string[] | null = null;
      let decidedBy: string | null = null;
      if (!missing) {
        const forfeits = (ix.forfeits.get(`${t.id}:${c.rec.round}`) ?? [])
          .filter((f) => f.rec.close === c.hash)
          .map((f) => ({ f, d: [...f.rec.counted].sort().filter((p) => frozen.has(p)) }))
          .filter(({ d }) => d.every(revealed))
          .sort((a, b) => cmp(forfeitRank(a.f.rec.by, t.id, c.rec.round), forfeitRank(b.f.rec.by, t.id, c.rec.round)) || cmp(a.f.hash, b.f.hash));
        if (forfeits.length) { counted = forfeits[0].d; decidedBy = forfeits[0].f.rec.by; }
        else if (frozenPids.every(revealed)) counted = frozenPids;
      }
      const decided = counted !== null;
      const seeds = (counted ?? []).map((p) => ix.reveals.get(`${t.id}:${c.rec.round}:${p}`)!.seed);
      const result = decided && seeds.length ? resultFrom(t.game, seeds, t.id, c.rec.round) : null;
      rounds.push({ out: { round: c.rec.round, close: c.hash, decided, counted: counted ?? [], decidedBy, frozen: frozenPids, pointBefore: tablePoint, result, payouts: {} }, frozen });
      if (!decided) break; // later rounds wait on this one
      if (t.game === 'craps' && Array.isArray(result)) tablePoint = nextPoint(tablePoint, result[0] + result[1]);
    }
    work.set(t.id, rounds);
  }

  // 2) Each player's ledger: their records in their own sequence order; a
  //    slip is accepted only if the player could cover it from buy-ins, earlier
  //    accepted stakes, and winnings from the rounds it said it counted.
  const pids = new Set<string>([...ix.cage.keys()]);
  for (const rounds of work.values()) for (const r of rounds) for (const p of r.frozen.keys()) pids.add(p);
  const tableGame = new Map(tables.map((t) => [t.id, t.game]));

  for (const pid of pids) {
    const cage = (ix.cage.get(pid) ?? []).sort((a, b) => a.seq - b.seq);
    const mySlips: { table: string; idx: number; slip: SlipRec }[] = [];
    for (const [tid, rounds] of work) rounds.forEach((r, idx) => { const s = r.frozen.get(pid); if (s) mySlips.push({ table: tid, idx, slip: s }); });
    mySlips.sort((a, b) => a.slip.seq - b.slip.seq);
    const accepted = new Map<SlipRec, boolean>();
    // Per-table running payouts for this player, computed round by round.
    const payoutAt = new Map<string, number[]>(); // table → payout per chain index
    const computed = new Map<string, number>(); // table → rounds computed so far
    const carried = new Map<string, CrapsBet[]>();
    const busy = new Set<SlipRec>();

    const computing = new Set<string>();
    const computeTableUpTo = (tid: string, idx: number): void => {
      // Re-entered through a basis that points at this table's later rounds:
      // those winnings aren't worked out yet, so they count as none.
      if (computing.has(tid)) return;
      computing.add(tid);
      const rounds = work.get(tid)!;
      const game = tableGame.get(tid)!;
      const pays = payoutAt.get(tid) ?? [];
      payoutAt.set(tid, pays);
      let i = computed.get(tid) ?? 0;
      for (; i <= idx && i < rounds.length; i++) {
        const r = rounds[i];
        const s = r.frozen.get(pid);
        const ok = s ? isAccepted(s) : false;
        if (!r.out.decided) break;
        const felt = game === 'craps' ? [...(carried.get(tid) ?? []), ...(ok ? (s!.bets as CrapsBet[]) : [])] : (ok ? s!.bets : []);
        let pay = 0;
        const forfeited = s && !r.out.counted.includes(pid);
        if (forfeited) {
          carried.set(tid, []);
        } else if (r.out.result === null) {
          // nobody revealed: no roll, riding bets stay up
        } else if (game === 'roulette') {
          pay = resolveRound({ [pid]: felt as RouletteBet[] }, r.out.result as number)[pid] ?? 0;
        } else {
          const [d1, d2] = r.out.result as [number, number];
          const res = resolveCrapsRound({ [pid]: felt as CrapsBet[] }, d1, d2, r.out.pointBefore);
          pay = res.payouts[pid] ?? 0;
          carried.set(tid, res.remaining[pid] ?? []);
        }
        pays[i] = pay;
        if (pay) r.out.payouts[pid] = pay;
        computed.set(tid, i + 1);
      }
      computing.delete(tid);
    };

    const stakeOf = (s: SlipRec): number => s.bets.reduce((n, b) => n + b.amount, 0);
    function isAccepted(s: SlipRec): boolean {
      const memo = accepted.get(s);
      if (memo !== undefined) return memo;
      if (busy.has(s)) return false; // a basis that loops back on itself
      busy.add(s);
      const where = mySlips.find((m) => m.slip === s)!;
      const game = tableGame.get(where.table)!;
      const pointBefore = work.get(where.table)![where.idx].out.pointBefore;
      let ok = verifier.verify(ix.keys.get(pid), s)
        && s.bets.every((b) => Number.isInteger(b.amount) && b.amount > 0)
        && (game !== 'craps' || s.bets.every((b) => canPlaceBet((b as CrapsBet).type, pointBefore)))
        && stakeOf(s) > 0;
      if (ok) {
        let avail = cage.filter((c) => c.seq < s.seq).reduce((n, c) => n + c.amount, 0);
        for (const m of mySlips) if (m.slip.seq < s.seq && isAccepted(m.slip)) avail -= stakeOf(m.slip);
        for (const [tid, upTo] of Object.entries(s.basis)) {
          const rounds = work.get(tid);
          if (!rounds) continue;
          const last = rounds.findIndex((r) => r.out.round === upTo);
          if (last < 0) continue; // counted a round that isn't on the chain: no winnings from it
          computeTableUpTo(tid, last);
          const pays = payoutAt.get(tid) ?? [];
          for (let j = 0; j <= last; j++) avail += pays[j] ?? 0;
        }
        ok = stakeOf(s) <= avail;
      }
      busy.delete(s);
      accepted.set(s, ok);
      return ok;
    }

    for (const tid of work.keys()) computeTableUpTo(tid, Infinity);
    let bal = cage.reduce((n, c) => n + c.amount, 0);
    out.boughtIn += bal;
    for (const m of mySlips) {
      if (isAccepted(m.slip)) { bal -= stakeOf(m.slip); out.houseNet += stakeOf(m.slip); }
      else out.rejected.push(`${m.table}:${m.slip.round}:${pid}`);
    }
    for (const pays of payoutAt.values()) for (const p of pays) { if (p) { bal += p; out.houseNet -= p; } }
    out.balances[pid] = bal;
  }

  for (const t of tables) {
    const rounds = work.get(t.id)!;
    let point: number | null = null;
    for (const r of rounds) if (t.game === 'craps' && Array.isArray(r.out.result)) point = nextPoint(point, r.out.result[0] + r.out.result[1]);
    out.tables[t.id] = { id: t.id, game: t.game, rounds: rounds.map((r) => r.out), point };
  }
  out.rejected.sort();
  return out;
}

export { sameSet };
