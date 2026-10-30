/**
 * 🧪🏠 The house in the simulated room (computedSim.ts) — for specs only; no
 * app code imports it.
 *
 * A twin of ssf-p2p-node's house job (house.rs), rule for rule, in
 * TypeScript: the same reads (a room counts once it holds this house's
 * delegation by the deed holder's pinned key; the house tables switched on
 * and live; each live session's slips, seeds, closes on the chain, abandons,
 * and its own records), the same duties (join, reveal, step down, beat, put
 * back) and the same bytes (computedHouse's derivations and signatures, the
 * fold's signed bytes: house_bytes.rs is held to them by the shared test
 * vectors). A change to one is a change to both.
 *
 * Where it runs: the owner's node is the house, and the owner's page talks to
 * the room through it. The sim has no node of its own, so the twin reads and
 * writes the doc of the house's page (the owner's), on its own clock, with
 * its own memory: what it revealed (house.rs's state file, kept across a
 * restart unless a scenario wipes it), when it first saw each close and
 * seed. Its writes are local transactions of that doc under HOUSE_ORIGIN, so
 * the page sends them to the room as it sends its own (and the sim's
 * oracles of a page's own writes leave them alone). While the owner's page is
 * gone, or asleep with its doc not syncing, the house hears nothing and
 * writes nothing: a simplification (the real node stays on the mesh while
 * its tab sleeps), which only makes the house look offline more often.
 */

import * as Y from 'yjs';
import {
  asCheckpointFor, dutyRank, gameOfInc, hasFields, houseCommitOf, houseRules, isPlain, isPub, isSig, MAX_CLOSES_PER_ROUND,
  MAX_FROZEN, MAX_HOUSE_COUNTED, nextSid, parseKey, recHash, signBytes, slipCommit,
} from './computedFold';
import type { FoldCtx, SignedKind } from './computedFold';
import { beatKey, delegationKey, HEARTBEAT_MS, housePubOf, houseSeedOf, houseSign, roomSignBytes } from './computedHouse';
import type { RoomKind } from './computedHouse';
import { verifyIdentityStrict } from './keypair';

/** The origin of the twin's transactions on the owner's page's doc. */
export const HOUSE_ORIGIN = Symbol('sim-house');

/** house.rs's timings (computedTable's grace, the pages' void at 15 s unheard). */
export const HOUSE_TICK_MS = 200;
const REPUT_MS = 1_000;
const REVEAL_GRACE_MS = 4_000;
const GRACE_PAD_MS = 1_500;
const GRACE_MAX_MS = 10_000;
export const REVEAL_CUTOFF_MS = 14_000;
/** house.rs SETTLE_MS: after it first reads a table, no join, and no reveal
 *  of a close first seen in this long. */
export const SETTLE_MS = 5_000;
const MAX_SESSION_KEYS = 8_192;

const HEX = (n: number): RegExp => new RegExp(`^[0-9a-f]{${n}}$`);
const HEX24 = HEX(24);
const HEX32 = HEX(32);
const HEX64 = HEX(64);
const isHex = (re: RegExp) => (v: unknown): v is string => typeof v === 'string' && re.test(v);
const isRound = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
/** casinoDoc isPlayerKey: 1–256 UTF-16 units, not `__proto__`. */
const isPid = (s: string): boolean => s.length > 0 && s.length <= 256 && s !== '__proto__';

interface Slip { r: number; pid: string; c: string; k: string }
interface Close { hash: string; r: number; q: string; f: [string, string][]; k: string; h: string | undefined; rank: string }

interface TableRead {
  ctx: FoldCtx;
  baseU: number;
  cpH: string | undefined;
  sesKey: string;
  slips: Map<string, Slip>;
  /** `${r}|${pid}` → the seeds revealed. */
  seeds: Map<string, string[]>;
  /** Closes on the chain (parent the session or a close of the round
   *  before; after a round this house decided, the close it decided), by
   *  round order. */
  closes: Close[];
  abandoned: Set<string>;
  /** Its own reveals (x: the close it decided; none, a step-down) and joins,
   *  as it signed them. */
  ownReveals: { r: number; c: string | undefined; x: string[] }[];
  ownJoins: { r: number; c: string }[];
}

interface TableMem {
  firstSeen: Map<string, number>;
  blocked: Set<string>;
  seedSeen: Map<string, number>;
  refused: Set<number>;
  /** Its own session records this run: [session key, key, record]. */
  written: [string, string, Record<string, unknown>][];
  /** When it first read the table this run (SETTLE_MS). */
  firstRead: number;
}

interface RoomMem {
  pins: Map<string, string>;
  delegation: Record<string, unknown> | null;
  fair: Map<string, Record<string, unknown>>;
  tables: Map<string, TableMem>;
  lastBeat: number | null;
  beatN: number;
  lastReput: number | null;
}

type Write = { ses: string; key: string; value: Record<string, unknown> } | { ses: null; key: string; value: Record<string, unknown> };

/** What one tick wrote, by kind (for a scenario's counters). */
export interface HouseTickOut { joins: number; reveals: number; stepDowns: number; beats: number; putBacks: number }

/** The house of a node whose secret key is `secret` (32 bytes). */
export class SimHouse {
  readonly pub: string;
  /** (room|t|inc) → the highest round revealed or stepped down: house.rs's
   *  state file. */
  readonly done = new Map<string, number>();
  private rooms = new Map<string, RoomMem>();
  private verdicts = new Map<string, boolean>();
  steppingDown = false;
  /** Totals of what it wrote. */
  readonly wrote: HouseTickOut = { joins: 0, reveals: 0, stepDowns: 0, beats: 0, putBacks: 0 };
  /** Rounds it gave up on (past the cutoff, a rival close), and closes it
   *  saw already abandoned or overtaken. */
  refusals = 0;
  blockedSeen = 0;

  constructor(private readonly secret: Uint8Array) {
    this.pub = housePubOf(secret);
  }

  /** A restart of the node: what it saw is gone, what it revealed is on disk
   *  (house.rs keeps `done` in its state file). */
  restart(): void {
    this.rooms = new Map();
    this.verdicts = new Map();
    this.steppingDown = false;
  }

  private seed(ctx: FoldCtx, r: number): string {
    return houseSeedOf(this.secret, ctx, r);
  }

  private commit(ctx: FoldCtx, r: number): string {
    return houseCommitOf(ctx, r, this.seed(ctx, r));
  }

  private signed(kind: SignedKind, ctx: FoldCtx, body: Record<string, unknown>): Record<string, unknown> {
    return { ...body, g: houseSign(this.secret, signBytes(kind, ctx, body)) };
  }

  /** Whether `g` is `k`'s signature of `bytes`, checked once per `id`: kind,
   *  room, table, incarnation and record hash (the signed bytes are bound to
   *  each: a copy elsewhere is checked anew). */
  private verified(id: [string, string, string, string, string], k: string, bytes: () => Uint8Array, g: string): boolean {
    const key = JSON.stringify(id);
    let ok = this.verdicts.get(key);
    if (ok === undefined) {
      try {
        ok = verifyIdentityStrict(k, bytes(), g);
      } catch {
        ok = false;
      }
      this.verdicts.set(key, ok);
    }
    return ok;
  }

  private roomOk(kind: RoomKind, room: string, t: string, v: Record<string, unknown>, k: string): boolean {
    return this.verified([kind, room, t, '', recHash(v) ?? ''], k, () => roomSignBytes(kind, room, t, v), v.g as string);
  }

  private doneOf(ctx: FoldCtx): number {
    return this.done.get(`${ctx.room}|${ctx.t}|${ctx.inc}`) ?? 0;
  }

  /** One tick in room `room` (doc `doc`), `now` the node's monotonic clock and
   *  `wall` its system clock (the heartbeat's count). Writes in one
   *  transaction under HOUSE_ORIGIN. */
  tick(room: string, doc: Y.Doc, now: number, wall: number): HouseTickOut {
    const out: HouseTickOut = { joins: 0, reveals: 0, stepDowns: 0, beats: 0, putBacks: 0 };
    const writes = this.plan(room, doc, now, wall, out);
    if (writes.length === 0) return out;
    const comp = doc.getMap('casinoComputed');
    doc.transact(() => {
      for (const w of writes) {
        if (w.ses === null) comp.set(w.key, w.value);
        else (comp.get(w.ses) as Y.Map<unknown> | undefined)?.set(w.key, w.value);
      }
    }, HOUSE_ORIGIN);
    for (const k of Object.keys(out) as (keyof HouseTickOut)[]) this.wrote[k] += out[k];
    return out;
  }

  private plan(room: string, doc: Y.Doc, now: number, wall: number, out: HouseTickOut): Write[] {
    const writes: Write[] = [];
    const comp = doc.getMap('casinoComputed');
    const owner = doc.getMap('roomInfo').get('owner');
    if (typeof owner !== 'string' || owner === '' || owner === 'Local-Clone') return writes;
    let mem = this.rooms.get(room);
    if (!mem) this.rooms.set(room, mem = { pins: new Map(), delegation: null, fair: new Map(), tables: new Map(), lastBeat: null, beatN: 0, lastReput: null });
    if (!mem.pins.has(owner)) {
      const entry = doc.getMap('players').get(owner) as { keyB64?: unknown } | undefined;
      const k = entry?.keyB64;
      if (typeof k !== 'string' || k === '' || k.length > 128) return writes;
      mem.pins.set(owner, k);
    }
    const ownerKey = mem.pins.get(owner)!;

    // The delegation: this house's key, signed by the deed holder.
    const delegKey = delegationKey(this.pub);
    const delegNow = comp.get(delegKey) as Record<string, unknown> | undefined;
    let delegation = mem.delegation && mem.delegation.k === ownerKey ? mem.delegation : null;
    if (!delegation && isPlain(delegNow) && hasFields(delegNow, ['v', 'h', 'k', 'g']) && delegNow.v === 1 && delegNow.h === this.pub
      && delegNow.k === ownerKey && this.roomOk('hkey', room, '', delegNow, ownerKey)) {
      delegation = delegNow;
    }
    if (!delegation) return writes;
    mem.delegation = delegation;

    // The owner's Fair settings, newest first seen (a new deed holder's count
    // afresh: the last one's settings go).
    for (const [t, v] of mem.fair) if (v.k !== ownerKey) mem.fair.delete(t);
    for (const [key, v] of comp.entries()) {
      if (!key.startsWith('hf:') || key.length <= 3) continue;
      const t = key.slice(3);
      if (!isPlain(v) || !hasFields(v, ['v', 'm', 's', 'k', 'g']) || v.v !== 1 || (v.m !== 0 && v.m !== 1) || !isRound(v.s) || v.k !== ownerKey) continue;
      const seen = mem.fair.get(t)?.s as number | undefined;
      if (seen !== undefined && seen >= v.s) continue;
      if (this.roomOk('hfair', room, t, v, ownerKey)) mem.fair.set(t, v);
    }

    // The switched-on house tables, live.
    const casino = doc.getMap('casino');
    const tables: [string, string][] = [];
    for (const [key, v] of casino.entries()) {
      if (!key.startsWith('cfg:computed:')) continue;
      const t = key.slice('cfg:computed:'.length);
      if (!isPlain(v) || !hasFields(v, ['v', 'inc']) || v.v !== 1 || typeof v.inc !== 'string') continue;
      const inc = v.inc;
      if (!/^[ckrd][0-9a-f]{24}$/.test(inc) || !houseRules(inc) || casino.has(`gone:${t}:${inc}`)) continue;
      tables.push([t, inc]);
    }
    tables.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));

    let fairTables = 0;
    for (const [t, inc] of tables) {
      const read = this.readTable(comp, { room, t, inc });
      if (!read) continue;
      const friendly = mem.fair.get(t)?.m === 1;
      if (!friendly) fairTables += 1;
      this.tableDuties(mem, read, friendly, now, writes, out);
    }

    // The heartbeat, while a table runs Fair.
    if (fairTables > 0 && !this.steppingDown && (mem.lastBeat === null || now - mem.lastBeat >= HEARTBEAT_MS)) {
      // It counts on from the doc's beat only as it signed it: a peer's copy
      // with a higher count would push its own past what the pages take.
      const beat = comp.get(beatKey(this.pub));
      const inDoc = isPlain(beat) && hasFields(beat, ['v', 'n', 'k', 'g']) && beat.v === 1 && beat.k === this.pub && isRound(beat.n)
        && this.roomOk('hbeat', room, '', beat, this.pub) ? beat.n as number : 0;
      const n = Math.min(Math.max(Math.min(wall, Number.MAX_SAFE_INTEGER), inDoc + 1, mem.beatN + 1), Number.MAX_SAFE_INTEGER);
      const body = { v: 1, n, k: this.pub };
      writes.push({ ses: null, key: beatKey(this.pub), value: { ...body, g: houseSign(this.secret, roomSignBytes('hbeat', room, '', body)) } });
      mem.beatN = n;
      mem.lastBeat = now;
      out.beats += 1;
    }

    // Put back what was taken away, every REPUT_MS.
    if (mem.lastReput === null || now - mem.lastReput >= REPUT_MS) {
      mem.lastReput = now;
      const same = (a: unknown, b: unknown): boolean => a !== undefined && recHash(a) === recHash(b);
      if (!same(delegNow, delegation)) {
        writes.push({ ses: null, key: delegKey, value: delegation });
        out.putBacks += 1;
      }
      // Each table's setting is the newest the deed holder signed, as read
      // above: anything else in its place goes, a forged one with a higher
      // count included.
      for (const [t, rec] of mem.fair) {
        const key = `hf:${t}`;
        if (!same(comp.get(key), rec)) {
          writes.push({ ses: null, key, value: rec });
          out.putBacks += 1;
        }
      }
      for (const table of mem.tables.values()) {
        for (const [ses, key, value] of table.written) {
          const m = comp.get(ses);
          const present = m instanceof Y.Map ? m.has(key) : true;
          if (!present && !writes.some((w) => w.ses !== null && w.key === key)) {
            writes.push({ ses, key, value });
            out.putBacks += 1;
          }
        }
      }
    }
    return writes;
  }

  /** Table ctx's live session, as house.rs read_table reads it (null with
   *  none, or once its incarnation has ended). */
  private readTable(comp: Y.Map<unknown>, ctx: FoldCtx): TableRead | null {
    const cp = asCheckpointFor(ctx)(comp.get(`sum:${ctx.t}:${ctx.inc}`));
    if (cp?.e === 1) return null;
    const sid = nextSid(ctx, cp);
    const sesKey = `ses:${ctx.t}:${ctx.inc}:${sid}`;
    const ses = comp.get(sesKey);
    if (!(ses instanceof Y.Map)) return null;
    const craps = gameOfInc(ctx.inc) === 'craps';
    const read: TableRead = {
      ctx, baseU: cp?.u ?? 0, cpH: cp?.h, sesKey, slips: new Map(), seeds: new Map(), closes: [], abandoned: new Set(), ownReveals: [], ownJoins: [],
    };
    const closes: [Close, Record<string, unknown>][] = [];
    const abandons: [string, string, Record<string, unknown>][] = [];
    const own: ['h' | 'o', number, string, Record<string, unknown>][] = [];
    let n = 0;
    for (const [key, v] of (ses as Y.Map<unknown>).entries()) {
      if (n++ >= MAX_SESSION_KEYS) break;
      const pk = parseKey(key);
      if (!pk || !isPlain(v)) continue;
      // The key must be the body's own (its round, pid and hash).
      if (v.r !== pk.r || recHash(v) !== pk.h) continue;
      if (pk.pid !== undefined && v.p !== pk.pid) continue;
      const k = isPub(v.k) ? v.k : undefined;
      const gOk = isSig(v.g);
      switch (pk.kind) {
        case 's': {
          const fieldsOk = craps
            ? hasFields(v, ['r', 'p', 'v', 'b', 'o', 'c', 'k', 'g'], ['t', 'l']) && isHex(HEX32)(v.o)
            : hasFields(v, ['r', 'p', 'v', 'b', 'c', 'k', 'g']);
          if (fieldsOk && gOk && Array.isArray(v.b) && isRound(v.v) && isHex(HEX64)(v.c) && k) {
            read.slips.set(pk.h, { r: pk.r, pid: pk.pid!, c: v.c as string, k });
          }
          break;
        }
        case 'x': {
          if (isHex(HEX64)(v.s) && hasFields(v, ['r', 'p', 's'])) {
            const at = `${pk.r}|${pk.pid}`;
            read.seeds.set(at, [...(read.seeds.get(at) ?? []), v.s as string]);
          }
          break;
        }
        case 'c': {
          if (!hasFields(v, ['r', 'q', 'f', 'k', 'g'], ['h']) || !gOk || !k) break;
          const q = v.q === 'g' || isHex(HEX24)(v.q) || isHex(HEX32)(v.q) ? v.q as string : null;
          if (v.h !== undefined && !isHex(HEX64)(v.h)) break;
          const fs = isPlain(v.f) ? Object.entries(v.f) : null;
          if (!q || !fs || fs.length === 0 || fs.length > MAX_FROZEN) break;
          if (!fs.every(([p, x]) => isPid(p) && isHex(HEX32)(x))) break;
          closes.push([{ hash: pk.h, r: pk.r, q, f: fs as [string, string][], k, h: v.h as string | undefined, rank: dutyRank('close', ctx, pk.r, k) }, v]);
          break;
        }
        case 'z': {
          if (hasFields(v, ['r', 'x', 'k', 'g']) && gOk && isHex(HEX32)(v.x) && k) abandons.push([v.x as string, k, v]);
          break;
        }
        case 'h':
        case 'o': {
          if (k === this.pub && gOk) own.push([pk.kind, pk.r, pk.h, v]);
          break;
        }
        default:
      }
    }
    // Its own records count as it signed them: a peer's copy under its key (a
    // reveal of a high round, say) would stop it joining and revealing.
    const at = (kind: string, hash: string): [string, string, string, string, string] => [kind, ctx.room, ctx.t, ctx.inc, hash];
    for (const [kind, r, hash, v] of own) {
      const signed = kind === 'h' ? 'hreveal' : 'hcommit';
      const shapeOk = kind === 'h' ? hasFields(v, ['r', 's', 'x', 'n', 'k', 'g'], ['c']) : hasFields(v, ['r', 'c', 'k', 'g']);
      if (!shapeOk || !this.verified(at(signed, hash), this.pub, () => signBytes(signed, ctx, v), v.g as string)) continue;
      if (kind === 'h') {
        const x = Array.isArray(v.x) ? v.x.filter((h): h is string => typeof h === 'string') : [];
        read.ownReveals.push({ r, c: typeof v.c === 'string' ? v.c : undefined, x });
      } else if (typeof v.c === 'string') read.ownJoins.push({ r, c: v.c });
    }
    // A close counts when one of the slips it freezes is its signer's...
    const good: Close[] = [];
    for (const [c, v] of closes) {
      const signer = c.f.some(([p, sh]) => {
        const s = read.slips.get(sh);
        return s !== undefined && s.pid === p && s.r === c.r && s.k === c.k;
      });
      if (signer && this.verified(at('close', c.hash), c.k, () => signBytes('close', ctx, v), v.g as string)) good.push(c);
    }
    // ...and its parent is the session (its first round) or a close counted
    // at the round before, no round skipped; after a round this house
    // decided, the close it decided: it reveals one close a round, and
    // carries on that line alone, so no rival gets a second look.
    good.sort((a, b) => a.r - b.r);
    const onChain = new Map<string, number>();
    for (const c of good) {
      const parentOk = c.r === read.baseU + 1 ? c.q === sid : c.r > read.baseU + 1 && onChain.get(c.q) === c.r - 1;
      const decided = read.ownReveals.filter((h) => h.r === c.r - 1).flatMap((h) => h.x);
      if (!parentOk || (decided.length > 0 && !decided.includes(c.q))) continue;
      onChain.set(c.hash, c.r);
      read.closes.push(c);
    }
    for (const [x, k, v] of abandons) {
      if (!onChain.has(x) || read.abandoned.has(x)) continue;
      if (this.verified(at('abandon', recHash(v) ?? ''), k, () => signBytes('abandon', ctx, v), v.g as string)) read.abandoned.add(x);
    }
    return read;
  }

  /** One table's reveal, step-down and join (house.rs table_duties). */
  private tableDuties(room: RoomMem, read: TableRead, friendly: boolean, now: number, writes: Write[], out: HouseTickOut): void {
    const { ctx } = read;
    let done = Math.max(this.doneOf(ctx), ...read.ownReveals.map((h) => h.r));
    const carried = (r: number): boolean => {
      const c = this.commit(ctx, r);
      return read.ownReveals.some((h) => h.r === r - 1 && h.c === c) || (r === read.baseU + 1 && read.cpH === c);
    };
    const joined = (r: number): boolean => {
      const c = this.commit(ctx, r);
      return read.ownJoins.some((j) => j.r === r && j.c === c);
    };
    const closesAt = (r: number): Close[] => read.closes.filter((c) => c.r === r);
    const nextRound = (): number => Math.max(read.baseU, ...read.closes.map((c) => c.r)) + 1;
    const tkey = `${ctx.t}|${ctx.inc}`;
    let mem = room.tables.get(tkey);
    if (!mem) room.tables.set(tkey, mem = { firstSeen: new Map(), blocked: new Set(), seedSeen: new Map(), refused: new Set(), written: [], firstRead: now });
    const settling = now - mem.firstRead < SETTLE_MS;
    // A trim opened a new session: what went into the old one is the trim's.
    mem.written = mem.written.filter(([ses]) => ses === read.sesKey);
    // Seeds as they come.
    for (const [hash, slip] of read.slips) {
      if (mem.seedSeen.has(hash)) continue;
      if ((read.seeds.get(`${slip.r}|${slip.pid}`) ?? []).some((s) => slipCommit(ctx, slip.r, slip.pid, s) === slip.c)) mem.seedSeen.set(hash, now);
    }

    const rounds = [...new Set(read.closes.map((c) => c.r).filter((r) => r > done))].sort((a, b) => a - b);
    const lastClosed = Math.max(0, ...read.closes.map((c) => c.r));
    let revealedNow: number | null = null;
    for (const r of rounds) {
      const commit = this.commit(ctx, r);
      const listed: Close[] = [];
      for (const c of closesAt(r).filter((x) => x.h === commit)) {
        if (!mem.firstSeen.has(c.hash)) {
          mem.firstSeen.set(c.hash, now);
          if (settling || read.abandoned.has(c.hash) || lastClosed > r) {
            mem.blocked.add(c.hash);
            this.blockedSeen += 1;
          }
        }
        if (!mem.blocked.has(c.hash)) listed.push(c);
      }
      if (listed.length === 0 || mem.refused.has(r)) continue;
      listed.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
      listed.length = Math.min(listed.length, MAX_CLOSES_PER_ROUND);
      // At a round it joined, a close naming anything else is a choice the
      // house won't hand out.
      if (!carried(r) && closesAt(r).some((c) => c.h !== commit)) {
        mem.refused.add(r);
        this.refusals += 1;
        continue;
      }
      const t0 = Math.min(...listed.map((c) => mem!.firstSeen.get(c.hash)!));
      if (now - t0 > REVEAL_CUTOFF_MS) {
        mem.refused.add(r);
        this.refusals += 1;
        continue;
      }
      const best = listed[0];
      const allIn = best.f.every(([, sh]) => mem!.seedSeen.has(sh));
      const times = best.f.map(([, sh]) => mem!.seedSeen.get(sh)).filter((x): x is number => x !== undefined);
      const due = allIn || now >= t0 + graceOf(t0, times);
      if (this.steppingDown && !allIn) break;
      if (!due) break;
      // The best-ranked close alone, and the slips it froze whose seeds it
      // saw: listing a rival too would show both outcomes, and let a bettor
      // carry on the one they liked.
      const n = [...new Set(best.f.map(([, sh]) => sh).filter((sh) => mem!.seedSeen.has(sh)))].sort().slice(0, MAX_HOUSE_COUNTED);
      const x = [best.hash];
      this.done.set(`${ctx.room}|${ctx.t}|${ctx.inc}`, r);
      const body: Record<string, unknown> = { r, s: this.seed(ctx, r), x, n };
      if (!friendly && !this.steppingDown) body.c = this.commit(ctx, r + 1);
      body.k = this.pub;
      this.writeSession(mem, read.sesKey, 'h', r, this.signed('hreveal', ctx, body), writes);
      out.reveals += 1;
      revealedNow = r;
      break;
    }
    if (revealedNow !== null) done = Math.max(done, revealedNow);

    if (friendly || this.steppingDown) {
      // Step down: the outstanding commitment, unless a close names it.
      if (revealedNow !== null) return;
      let r: number | null = null;
      for (let at = done + 1; at <= Math.max(nextRound(), done + 1); at++) {
        if (carried(at) || joined(at)) {
          r = at;
          break;
        }
      }
      if (r === null) return;
      const commit = this.commit(ctx, r);
      if (closesAt(r).some((c) => c.h === commit)) return;
      this.done.set(`${ctx.room}|${ctx.t}|${ctx.inc}`, r);
      this.writeSession(mem, read.sesKey, 'h', r, this.signed('hreveal', ctx, { r, s: this.seed(ctx, r), x: [], n: [], k: this.pub }), writes);
      out.stepDowns += 1;
      return;
    }

    // Join the next round, when it asks for no commitment of this house (nor
    // will: the round before is not one of its own still to reveal).
    const r = nextRound();
    if (settling || r <= done || revealedNow !== null || carried(r) || joined(r)) return;
    if (mem.written.some(([, k]) => k.startsWith(`o:${r}:`))) return;
    const before = this.commit(ctx, r - 1);
    const toReveal = r - 1 > done && !mem.refused.has(r - 1)
      && closesAt(r - 1).some((c) => c.h === before && !mem!.blocked.has(c.hash));
    if (toReveal) return;
    this.writeSession(mem, read.sesKey, 'o', r, this.signed('hcommit', ctx, { r, c: this.commit(ctx, r), k: this.pub }), writes);
    out.joins += 1;
  }

  private writeSession(mem: TableMem, ses: string, kind: 'h' | 'o', r: number, rec: Record<string, unknown>, writes: Write[]): void {
    const key = `${kind}:${r}:${recHash(rec)}`;
    mem.written.push([ses, key, rec]);
    writes.push({ ses, key, value: rec });
  }
}

/** computedTable graceOf, as house.rs grace_of has it. */
function graceOf(t0: number, times: number[]): number {
  let grace = REVEAL_GRACE_MS;
  for (const at of [...times].sort((a, b) => a - b)) {
    const d = Math.max(0, at - t0);
    if (d > grace) break;
    grace = Math.min(GRACE_MAX_MS, Math.max(grace, d + GRACE_PAD_MS));
  }
  return grace;
}
