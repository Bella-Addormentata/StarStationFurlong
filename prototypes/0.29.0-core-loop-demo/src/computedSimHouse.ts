/**
 * 🧪🏠 The house in the simulated room (computedSim.ts) — for specs only; no
 * app code imports it.
 *
 * A twin of ssf-p2p-node's house job (house.rs), rule for rule, in
 * TypeScript: the same reads (a room counts once it holds this house's
 * delegation by the deed holder's pinned key; the house tables switched on
 * and live; each live session's slips, seeds, the closes the pages' fold
 * takes as eligible, forfeits, abandons, and every delegated house's
 * records), the same duties (join, reveal, step down, beat, put back) and
 * the same bytes (computedHouse's derivations and signatures, the
 * fold's signed bytes: house_bytes.rs is held to them by the shared test
 * vectors). A change to one is a change to both.
 *
 * Where it runs: the owner's node is the house, and the owner's page talks to
 * the room through it. The sim has no node of its own, so the twin reads and
 * writes the doc of the house's page (the owner's), on its own clock, with
 * its own memory: what it revealed and decided, and its reveals (house.rs's
 * state file, kept across a restart unless a scenario wipes it), when it
 * first saw each close and seed. Its writes are local transactions of that doc under HOUSE_ORIGIN, so
 * the page sends them to the room as it sends its own (and the sim's
 * oracles of a page's own writes leave them alone). While the owner's page is
 * gone, or asleep with its doc not syncing, the house hears nothing and
 * writes nothing: a simplification (the real node stays on the mesh while
 * its tab sleeps), which only makes the house look offline more often.
 */

import * as Y from 'yjs';
import {
  asAbandon, asCheckpointFor, asForfeit, asHouseCommit, asHouseReveal, asSlipFor, dutyRank, hasFields, houseCommitOf, houseRules,
  isPlain, isPub, isSig, MAX_CLOSES_PER_ROUND, MAX_FROZEN, MAX_HOUSE_COUNTED, nextSid, parseKey, recHash, signBytes, slipCommit,
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
/** house.rs MAX_KEPT: the most reveals of a session its state file keeps. */
const MAX_KEPT = 64;

const HEX = (n: number): RegExp => new RegExp(`^[0-9a-f]{${n}}$`);
const HEX24 = HEX(24);
const HEX32 = HEX(32);
const HEX64 = HEX(64);
const isHex = (re: RegExp) => (v: unknown): v is string => typeof v === 'string' && re.test(v);
const isRound = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
/** casinoDoc isPlayerKey: 1–256 UTF-16 units, not `__proto__`. */
const isPid = (s: string): boolean => s.length > 0 && s.length <= 256 && s !== '__proto__';

/** A slip as the fold reads it (asSlipFor): `chips`, something on it (only
 *  such a slip can sign a close). */
interface Slip { r: number; pid: string; c: string; k: string; chips: boolean; v: Record<string, unknown> }
interface Close { hash: string; r: number; q: string; f: [string, string][]; k: string; h: string | undefined; rank: string }
/** A reveal of any house the deed holder delegated, as it signed it:
 *  `commit` is the commitment its seed opens; `x` empty, a step-down. */
interface Reveal { k: string; r: number; hash: string; commit: string; x: string[]; n: string[]; c: string | undefined }
interface Join { k: string; r: number; hash: string; c: string }
interface Forfeit { hash: string; r: number; x: string; n: string[]; k: string; v: Record<string, unknown> }
/** How a close on the chain was decided (computedFold decide): by a house's
 *  reveal (carrying the commitment the next round must name, if any), or
 *  otherwise (a forfeit, every seed in, an abandon). */
type Decision = { house: true; c: string | undefined } | { house: false };

interface TableRead {
  ctx: FoldCtx;
  baseU: number;
  cpH: string | undefined;
  sesKey: string;
  slips: Map<string, Slip>;
  /** `${r}|${pid}` → the seeds revealed. */
  seeds: Map<string, string[]>;
  /** The closes the pages' fold takes as eligible (computedFold compute,
   *  step 1), by round: signed by a slip they freeze, under a parent decided
   *  at the round before (the session, for the first), naming what their
   *  round asks for, the first MAX_CLOSES_PER_ROUND by rank. After a round a
   *  house decided, only the close it decided has children here. */
  closes: Close[];
  /** The latest round a signed close reaches on a line of them from the
   *  base, decided or not (house.rs TableRead top). */
  top: number;
  abandoned: Set<string>;
  /** Every delegated house's reveals and joins, this one's among them. */
  reveals: Reveal[];
  joins: Join[];
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
  /** Each player's key as first seen (trust on first use, as the pages pin). */
  pins: Map<string, string>;
  delegation: Record<string, unknown> | null;
  /** Every other house the deed holder delegated, with the key that signed
   *  its delegation, as first verified (casinoDoc housePinned). */
  houses: Map<string, string>;
  fair: Map<string, Record<string, unknown>>;
  tables: Map<string, TableMem>;
  lastBeat: number | null;
  beatN: number;
  lastReput: number | null;
}

/** What it last did at a table (house.rs Done, in its state file): the
 *  highest round revealed or stepped down; the last round it decided and the
 *  close it decided there (a step-down after keeps them); whether the reveal
 *  of round `r` carried the next commitment; and its reveals in the live
 *  session, as it wrote them (put back after a restart, as during a run).
 *  The doc's copy of a reveal can be deleted; these hold all the same. */
interface Done { r: number; d: [number, string] | undefined; c: boolean; kept: Kept[] }
interface Kept { ses: string; key: string; rec: Record<string, unknown> }

type Write = { ses: string; key: string; value: Record<string, unknown> } | { ses: null; key: string; value: Record<string, unknown> };

/** What one tick wrote, by kind (for a scenario's counters). */
export interface HouseTickOut { joins: number; reveals: number; stepDowns: number; beats: number; putBacks: number }

/** The house of a node whose secret key is `secret` (32 bytes). */
export class SimHouse {
  readonly pub: string;
  /** (room|t|inc) → what it last revealed or stepped down: house.rs's state
   *  file. */
  readonly done = new Map<string, Done>();
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

  private lastOf(ctx: FoldCtx): Done | undefined {
    return this.done.get(`${ctx.room}|${ctx.t}|${ctx.inc}`);
  }

  private doneOf(ctx: FoldCtx): number {
    return this.lastOf(ctx)?.r ?? 0;
  }

  /** Player `pid`'s key as this house first saw it in the room's players map
   *  (trust on first use, as the pages pin: casinoDoc computedPinOf). */
  private pinOf(mem: RoomMem, doc: Y.Doc, pid: string): string | undefined {
    let k = mem.pins.get(pid);
    if (k === undefined) {
      const entry = doc.getMap('players').get(pid) as { keyB64?: unknown } | undefined;
      const seen = isPlain(entry) ? entry.keyB64 : undefined;
      if (typeof seen !== 'string' || seen === '' || seen.length > 128) return undefined;
      mem.pins.set(pid, k = seen);
    }
    return k;
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
    if (!mem) {
      this.rooms.set(room, mem = { pins: new Map(), delegation: null, houses: new Map(), fair: new Map(), tables: new Map(), lastBeat: null, beatN: 0, lastReput: null });
    }
    const roomMem = mem;
    const ownerKey = this.pinOf(roomMem, doc, owner);
    if (ownerKey === undefined) return writes;

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

    // Every house the deed holder delegated: another of their nodes is a
    // house of the room as this one is, and its records hold the line, the
    // joins and the step-downs as this one's do.
    for (const [key, v] of comp.entries()) {
      const h = key.startsWith('hk:') ? key.slice(3) : '';
      if (!isPub(h) || h === this.pub || mem.houses.get(h) === ownerKey) continue;
      if (isPlain(v) && hasFields(v, ['v', 'h', 'k', 'g']) && v.v === 1 && v.h === h && v.k === ownerKey && this.roomOk('hkey', room, '', v, ownerKey)) {
        mem.houses.set(h, ownerKey);
      }
    }
    const houses = new Set([...mem.houses].filter(([, k]) => k === ownerKey).map(([h]) => h));
    houses.add(this.pub);

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
      const read = this.readTable(comp, { room, t, inc }, houses);
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
          // There as it wrote it: junk under its key reads as nothing on
          // every page, and goes too.
          const m = comp.get(ses);
          const present = m instanceof Y.Map ? same(m.get(key), value) : true;
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
   *  none, or once its incarnation has ended). `houses`: every house the deed
   *  holder delegated, this one among them. */
  private readTable(comp: Y.Map<unknown>, ctx: FoldCtx, houses: Set<string>): TableRead | null {
    const cp = asCheckpointFor(ctx)(comp.get(`sum:${ctx.t}:${ctx.inc}`));
    if (cp?.e === 1) return null;
    const sid = nextSid(ctx, cp);
    const sesKey = `ses:${ctx.t}:${ctx.inc}:${sid}`;
    const ses = comp.get(sesKey);
    if (!(ses instanceof Y.Map)) return null;
    const asSlip = asSlipFor(ctx);
    const read: TableRead = {
      ctx, baseU: cp?.u ?? 0, cpH: cp?.h, sesKey, slips: new Map(), seeds: new Map(), closes: [], top: cp?.u ?? 0, abandoned: new Set(),
      reveals: [], joins: [],
    };
    const closes: [Close, Record<string, unknown>][] = [];
    const abandons: [string, number, string, Record<string, unknown>][] = [];
    const forfeits: Forfeit[] = [];
    const houseRecs: ['h' | 'o', number, string, Record<string, unknown>, string][] = [];
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
          // As the fold reads it, its felt included: a close signed over a
          // felt the pages throw out counts on no page, so the house must not
          // reveal it either.
          const s = asSlip(v);
          if (s) read.slips.set(pk.h, { r: pk.r, pid: pk.pid!, c: s.c, k: s.k, chips: s.b.length > 0, v });
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
        case 'f': {
          const f = asForfeit(v);
          if (f) forfeits.push({ hash: pk.h, r: pk.r, x: f.x, n: [...f.n], k: f.k, v });
          break;
        }
        case 'z': {
          if (asAbandon(v)) abandons.push([v.x as string, pk.r, v.k as string, v]);
          break;
        }
        case 'h':
        case 'o': {
          if (gOk && k !== undefined && houses.has(k)) houseRecs.push([pk.kind, pk.r, pk.h, v, k]);
          break;
        }
        default:
      }
    }
    // The houses' records count as each signed them: a peer's copy under this
    // house's key (a reveal of a high round, say) would stop it joining and
    // revealing; under another's, change what a round may name.
    const at = (kind: string, hash: string): [string, string, string, string, string] => [kind, ctx.room, ctx.t, ctx.inc, hash];
    for (const [kind, r, hash, v, k] of houseRecs) {
      if (kind === 'h') {
        const e = asHouseReveal(v);
        if (e && this.verified(at('hreveal', hash), k, () => signBytes('hreveal', ctx, v), v.g as string)) {
          read.reveals.push({ k, r, hash, commit: houseCommitOf(ctx, r, e.s), x: [...e.x], n: [...e.n], c: e.c });
        }
      } else {
        const o = asHouseCommit(v);
        if (o && this.verified(at('hcommit', hash), k, () => signBytes('hcommit', ctx, v), v.g as string)) read.joins.push({ k, r, hash, c: o.c });
      }
    }
    // A close counts when it is signed by one of the slips it freezes, that
    // slip as the pages take it (computedFold closeInfo): its signature good,
    // chips on it. One the pages throw out would only void the round's real
    // close if revealed.
    const good: Close[] = [];
    for (const [c, v] of closes) {
      const signer = c.f.some(([p, sh]) => {
        const s = read.slips.get(sh);
        return s !== undefined && s.pid === p && s.r === c.r && s.k === c.k && s.chips && this.slipOk(ctx, sh, s);
      });
      if (signer && this.verified(at('close', c.hash), c.k, () => signBytes('close', ctx, v), v.g as string)) good.push(c);
    }
    good.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    // How far a line of signed closes reaches, decided or not.
    let line = new Set([sid]);
    for (;;) {
      const on = new Set(good.filter((c) => c.r === read.top + 1 && line.has(c.q)).map((c) => c.hash));
      if (on.size === 0) break;
      read.top += 1;
      line = on;
    }
    // The chain as the pages' fold walks it (computedFold compute, step 1):
    // round by round from the base, a close is eligible under a parent
    // decided at the round before (the session, for the first), naming what
    // its round asks for; the first round with nothing decided ends it, and
    // only the first MAX_CLOSES_PER_ROUND by rank take a place. And the
    // house's own rule on top: after a round a house decided, only the close
    // it decided has children (its own memory of it too: a peer can delete
    // the reveal), so no rival gets a second look.
    const remembered = this.lastOf(ctx)?.d;
    let before = new Map<string, Decision>();
    for (let r = read.baseU + 1; ; r++) {
      const atR = good.filter((c) => c.r === r);
      if (atR.length === 0) break;
      const first = r === read.baseU + 1;
      const houseLine = [...before].filter(([, d]) => d.house).map(([h]) => h);
      const here = new Map<string, Decision>();
      let considered = 0;
      for (const c of atR) {
        if (first ? c.q !== sid : !before.has(c.q)) continue;
        const parent = before.get(c.q);
        const req = first ? read.cpH : parent?.house ? parent.c : undefined;
        if (!commitOk(read, c, req)) continue;
        if (considered >= MAX_CLOSES_PER_ROUND) break;
        considered += 1;
        if (houseLine.length > 0 && !houseLine.includes(c.q)) continue;
        if (remembered !== undefined && remembered[0] === r - 1 && remembered[0] > read.baseU && remembered[1] !== c.q) continue;
        const d = this.decide(read, c, forfeits, abandons);
        if (d) here.set(c.hash, d);
        read.closes.push(c);
      }
      if (here.size === 0) break;
      before = here;
    }
    const eligible = new Set(read.closes.map((c) => c.hash));
    for (const [x, r, k, v] of abandons) {
      if (!eligible.has(x) || read.abandoned.has(x)) continue;
      if (this.abandonOk(ctx, r, k, v)) read.abandoned.add(x);
    }
    return read;
  }

  private slipOk(ctx: FoldCtx, hash: string, s: Slip): boolean {
    return this.verified(['slip', ctx.room, ctx.t, ctx.inc, hash], s.k, () => signBytes('slip', ctx, s.v), s.v.g as string);
  }

  private abandonOk(ctx: FoldCtx, _r: number, k: string, v: Record<string, unknown>): boolean {
    return this.verified(['abandon', ctx.room, ctx.t, ctx.inc, recHash(v) ?? ''], k, () => signBytes('abandon', ctx, v), v.g as string);
  }

  /** Whether close c is decided, and how (computedFold decide): a Fair one by
   *  a house's reveal listing it once every seed it counts is in, a Friendly
   *  one by a forfeit, or by every frozen slip there with its seed; either by
   *  an abandon. */
  private decide(read: TableRead, c: Close, forfeits: Forfeit[], abandons: [string, number, string, Record<string, unknown>][]): Decision | null {
    const { ctx } = read;
    const craps = ctx.inc.startsWith('k') || ctx.inc.startsWith('d');
    // P, the frozen slips there and good (at roulette with chips on:
    // computedFold frozenOk), and how many aren't (M).
    const present: [string, string, Slip][] = [];
    let missing = 0;
    for (const [p, sh] of c.f) {
      const s = read.slips.get(sh);
      if (s && s.pid === p && s.r === c.r && (craps || s.chips) && this.slipOk(ctx, sh, s)) present.push([p, sh, s]);
      else missing += 1;
    }
    const seeded = (p: string, s: Slip): boolean => (read.seeds.get(`${c.r}|${p}`) ?? []).some((x) => slipCommit(ctx, c.r, p, x) === s.c);
    let decided: Decision | null = null;
    if (c.h !== undefined) {
      const hr = read.reveals.filter((e) => e.r === c.r && e.commit === c.h && e.x.includes(c.hash)).sort((a, b) => (a.hash < b.hash ? -1 : 1))[0];
      if (hr && present.filter(([, sh]) => hr.n.includes(sh)).every(([p, , s]) => seeded(p, s))) decided = { house: true, c: hr.c };
    } else {
      for (const f of forfeits.filter((x) => x.x === c.hash && x.r === c.r)) {
        const inP = (p: string): [string, string, Slip] | undefined => present.find(([q]) => q === p);
        if (!f.n.every((p) => { const e = inP(p); return e !== undefined && seeded(e[0], e[2]); })) continue;
        if (!f.n.some((p) => inP(p)?.[2].k === f.k)) continue;
        if (this.verified(['forfeit', ctx.room, ctx.t, ctx.inc, f.hash], f.k, () => signBytes('forfeit', ctx, f.v), f.v.g as string)) {
          decided = { house: false };
          break;
        }
      }
      if (!decided && missing === 0 && present.every(([p, , s]) => seeded(p, s))) decided = { house: false };
    }
    if (!decided) {
      for (const [x, r, k, v] of abandons) {
        if (x === c.hash && r === c.r && this.abandonOk(ctx, r, k, v)) {
          decided = { house: false };
          break;
        }
      }
    }
    return decided;
  }

  /** Its reveals at table `ctx` in session `ses` so far, and `rec`: the
   *  newest MAX_KEPT. */
  private keptWith(ctx: FoldCtx, ses: string, rec: Record<string, unknown>): Kept[] {
    const kept = (this.lastOf(ctx)?.kept ?? []).filter((k) => k.ses === ses);
    kept.push({ ses, key: `h:${rec.r as number}:${recHash(rec)}`, rec });
    return kept.slice(-MAX_KEPT);
  }

  /** One table's reveal, step-down and join (house.rs table_duties). */
  private tableDuties(room: RoomMem, read: TableRead, friendly: boolean, now: number, writes: Write[], out: HouseTickOut): void {
    const { ctx } = read;
    const own = read.reveals.filter((h) => h.k === this.pub);
    const doneKey = `${ctx.room}|${ctx.t}|${ctx.inc}`;
    let done = Math.max(this.doneOf(ctx), ...own.map((h) => h.r));
    const carried = (r: number): boolean => {
      const c = this.commit(ctx, r);
      const last = this.lastOf(ctx);
      return own.some((h) => h.r === r - 1 && h.c === c) || (last?.r === r - 1 && last.c)
        || (r === read.baseU + 1 && read.cpH === c);
    };
    const joined = (r: number): boolean => {
      const c = this.commit(ctx, r);
      return read.joins.some((o) => o.r === r && o.k === this.pub && o.c === c);
    };
    const closesAt = (r: number): Close[] => read.closes.filter((c) => c.r === r);
    const nextRound = (): number => Math.max(read.baseU, ...read.closes.map((c) => c.r)) + 1;
    const tkey = `${ctx.t}|${ctx.inc}`;
    let mem = room.tables.get(tkey);
    if (!mem) {
      room.tables.set(tkey, mem = { firstSeen: new Map(), blocked: new Set(), seedSeen: new Map(), refused: new Set(), written: [], firstRead: now });
      // After a start: its reveals from before go back as this run's do.
      for (const k of this.lastOf(ctx)?.kept ?? []) mem.written.push([k.ses, k.key, k.rec]);
    }
    const settling = now - mem.firstRead < SETTLE_MS;
    // A trim opened a new session: what went into the old one is the trim's.
    mem.written = mem.written.filter(([ses]) => ses === read.sesKey);
    // Seeds as they come.
    for (const [hash, slip] of read.slips) {
      if (mem.seedSeen.has(hash)) continue;
      if ((read.seeds.get(`${slip.r}|${slip.pid}`) ?? []).some((s) => slipCommit(ctx, slip.r, slip.pid, s) === slip.c)) mem.seedSeen.set(hash, now);
    }

    const rounds = [...new Set(read.closes.map((c) => c.r).filter((r) => r > done))].sort((a, b) => a - b);
    let revealedNow: number | null = null;
    for (const r of rounds) {
      const commit = this.commit(ctx, r);
      const listed: Close[] = [];
      for (const c of closesAt(r).filter((x) => x.h === commit)) {
        if (!mem.firstSeen.has(c.hash)) {
          mem.firstSeen.set(c.hash, now);
          if (settling || read.abandoned.has(c.hash) || read.top > r) {
            mem.blocked.add(c.hash);
            this.blockedSeen += 1;
          }
        }
        if (!mem.blocked.has(c.hash)) listed.push(c);
      }
      if (listed.length === 0 || mem.refused.has(r)) continue;
      listed.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
      listed.length = Math.min(listed.length, MAX_CLOSES_PER_ROUND);
      // At a round it joined: a Friendly close beside is a choice the house
      // won't hand out (see that close's result, then choose); and of several
      // houses' joins the pages name the lowest, so the round is that one's.
      const firstJoin = joinsAt(read, r)[0];
      if (!carried(r) && (closesAt(r).some((c) => c.h === undefined) || firstJoin?.c !== commit)) {
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
      const next = !friendly && !this.steppingDown;
      const body: Record<string, unknown> = { r, s: this.seed(ctx, r), x: [best.hash], n };
      if (next) body.c = this.commit(ctx, r + 1);
      body.k = this.pub;
      const rec = this.signed('hreveal', ctx, body);
      this.done.set(doneKey, { r, d: [r, best.hash], c: next, kept: this.keptWith(ctx, read.sesKey, rec) });
      this.writeSession(mem, read.sesKey, 'h', r, rec, writes);
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
      const rec = this.signed('hreveal', ctx, { r, s: this.seed(ctx, r), x: [], n: [], k: this.pub });
      // (The close it last decided stays: the round after it carries on
      // that line alone, whatever is deleted.)
      this.done.set(doneKey, { r, d: this.lastOf(ctx)?.d, c: false, kept: this.keptWith(ctx, read.sesKey, rec) });
      this.writeSession(mem, read.sesKey, 'h', r, rec, writes);
      out.stepDowns += 1;
      return;
    }

    // Join the next round, when it asks for no commitment of this house (nor
    // will: the round before is not one of its own still to reveal).
    const r = nextRound();
    if (settling || r <= done || revealedNow !== null || carried(r) || joined(r)) return;
    // Nor when another of the owner's houses has: it joined the round, or its
    // reveal of the round before carried a commitment no step-down has lifted
    // (one house to a round: two would let a bettor see both outcomes).
    if (joinsAt(read, r).length > 0 || read.reveals.some((h) => h.r === r - 1 && h.c !== undefined && !steppedDown(read, r, h.c))) return;
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

/** computedFold steppedDown: a house's step-down at round r opened `h`. */
function steppedDown(read: TableRead, r: number, h: string): boolean {
  return read.reveals.some((e) => e.r === r && e.x.length === 0 && e.commit === h);
}

/** Round r's joins that count (not stepped down), lowest hash first: the
 *  pages' close names the first (computedTable, `res.joins[0]`). */
function joinsAt(read: TableRead, r: number): Join[] {
  return read.joins.filter((o) => o.r === r && !steppedDown(read, r, o.c)).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
}

/** computedFold commitState: whether close c names what its round asks for,
 *  `req` the commitment its parent's deciding reveal carried (the
 *  checkpoint's, for the first round): that one, unless a step-down lifted
 *  it; else nothing, or a counted join's commitment no step-down revealed. */
function commitOk(read: TableRead, c: Close, req: string | undefined): boolean {
  if (req !== undefined && !steppedDown(read, c.r, req)) return c.h === req;
  if (c.h === undefined) return true;
  const h = c.h;
  return !steppedDown(read, c.r, h) && read.joins.some((o) => o.r === c.r && o.c === h);
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
