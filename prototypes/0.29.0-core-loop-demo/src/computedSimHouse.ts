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
import { isFairOnlyInc, parseFairOnlyKey, sealCk } from './computedFairOnly';
import type { CkRec, FinRec } from './computedFairOnly';
import { resolveGame } from './computedFairOnlyAuth';
import type { AuthRecords, Counted, Resolution } from './computedFairOnlyAuth';
import {
  asAbandon, asCheckpointFor, canon, asForfeit, asHouseCommit, asHouseReveal, asSlipFor, dutyRank, foldGameOf, gameOfInc, hasFields, houseCommitOf, houseRules,
  isPlain, isPub, isSig, MAX_CLOSES_PER_ROUND, MAX_FROZEN, MAX_HELD_ROUNDS, MAX_HOUSE_COUNTED, MAX_TABLE_PIDS, nextSid, nextSid3, parseKey, recHash,
  signBytes, slipCommit, TableFold,
} from './computedFold';
import type { FoldCtx, FoldResult, RoundView, SignedKind } from './computedFold';
import { beatKey, delegationKey, fairAfter, HEARTBEAT_MS, HOUSE_HEARD_MS, housePubOf, houseSeedOf, houseSign, roomSignBytes } from './computedHouse';
import type { DelegationRec, FairSettingRec, RoomKind } from './computedHouse';
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

// 🔒 FAIR ONLY (design §8.5 N3, §8.9): when the house trims a game's session.
/** After the reveal or abandon that decided the round it trims to: inside the
 *  pages' show beat. */
export const HOUSE_TRIM_AFTER_MS = 2_500;
/** A decided round's frozen slip that is missing is waited for this long
 *  (computedTable MISSING_WAIT_MS). */
const MISSING_WAIT_MS = 30_000;
/** The pressures (computedTable TRIM_ROUNDS, TRIM_BYTES, ROOM_BYTES,
 *  ROOM_MIN_BYTES, IDLE_MS; computedCraps TRIM_SEVEN_OUT_MIN), on kept bytes. */
export const HOUSE_TRIM_ROUNDS = 20;
const HOUSE_TRIM_BYTES = 96 * 1024;
const HOUSE_ROOM_BYTES = 384 * 1024;
const HOUSE_ROOM_MIN_BYTES = 24 * 1024;
const HOUSE_SEVEN_OUT_MIN = 8;
export const HOUSE_IDLE_MS = 60_000;
/** …and junk (design §8.9 SWEEP_BYTES): what the session weighs past what the
 *  fold used. The design sweeps a session with nothing decided yet and says
 *  "a trim sweeps too", but lists no pressure that makes a trim come for junk:
 *  old versions of the felts alone (each bet a player changes leaves one)
 *  would pile up until the session was long or idle. So junk presses a trim
 *  as it would a sweep. */
export const HOUSE_SWEEP_BYTES = 48 * 1024;
/** The sweep (design §8.5 N3s, §8.9 SWEEP_KEYS, SWEEP_MIN_MS): a session with
 *  no round decided since its base is cleared of junk by the base's content
 *  signed again, one sweep on (`w`), when the junk weighs HOUSE_SWEEP_BYTES or
 *  is this many keys (a key of nothing weighs little), and at most this often. */
export const HOUSE_SWEEP_KEYS = 2_048;
export const HOUSE_SWEEP_MIN_MS = 10_000;
/** A game's session is folded for a trim at most this often (the fold is the
 *  engine's work, off the tick in the node: §7.3). */
const FOLD_EVERY_MS = 1_000;

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

/** What a table's live session continues from: at a house table its `sum:`
 *  checkpoint (none: the incarnation's first session), at a FAIR ONLY game the
 *  checkpoint its resolution chose. */
interface Base { u: number; h: string | undefined; sid: string }

interface TableRead {
  ctx: FoldCtx;
  /** The live session's id. */
  sid: string;
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
  /** How many keys the session holds. */
  keys: number;
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
  /** 🔒 A FAIR ONLY game's (the rest are its trims'). */
  fo: boolean;
  /** When each close was decided, as this house saw it: its own reveal, as it
   *  wrote it; an abandon, as it first read the close decided by one. */
  decidedAt: Map<string, number>;
  /** When it first read each decided close with a frozen slip missing. */
  missingAt: Map<string, number>;
  /** The live session's keys as last read, and when one last came. */
  keys: number;
  lastNewKey: number;
  lastFold: number | null;
  /** The session's kept bytes as it last folded them (the room's pressure). */
  kept: number;
  /** When it last swept the game (HOUSE_SWEEP_MIN_MS). */
  lastSweep: number | null;
  /** The round-u copies its last trim carried into the session of checkpoint
   *  `base`: a sweep of that session carries them on. */
  carried: { base: string; keys: string[] } | null;
  /** 🔒 When it first saw the session read short of a round it revealed (readsShort). */
  shortAt: number | null;
}

/** 🔒 A FAIR ONLY game this house serves: its resolution, the base its live
 *  session continues from, and the delegation that makes this house the one
 *  that decides the rounds after it. */
interface Game { ctx: FoldCtx; res: Resolution; base: Counted; dl: DelegationRec; sesKey: string }

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

type Write =
  | { ses: string; key: string; value: Record<string, unknown> }
  | { ses: null; key: string; value: Record<string, unknown> }
  /** 🔒 house.rs Write::Trim: the checkpoint in (if absent), every session map
   *  and every other checkpoint of the incarnation out, and the session the
   *  checkpoint opens in with its copies. */
  | { trim: { t: string; inc: string; key: string; value: CkRec; ses: string | null; copies: [string, unknown][] } }
  /** 🔒 Write::NewSession: the live session's map, when the doc lost it. */
  | { newSession: string };

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
  /** 🔒 (room|t|inc) → the last checkpoint it signed for a FAIR ONLY game:
   *  house.rs's `house-checkpoints.json`, kept across a restart. */
  readonly rows = new Map<string, { key: string; value: CkRec }>();
  /** 🔒 What it did at FAIR ONLY games: trims written, checkpoints and session
   *  maps put back, and trims its cross-check refused to sign. */
  trims = 0;
  /** 🔒 Sweeps written: a game's base signed again to clear a junked session. */
  sweeps = 0;
  /** Games it ended (endDuty). */
  ends = 0;
  rowPutBacks = 0;
  newSessions = 0;
  crossCheckMismatches = 0;
  /** 🔒 For a spec: change a trim's body before the cross-check sees it (a
   *  planted engine fault). */
  faultTrim: ((body: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** When each room was last ticked: a house cut off for HOUSE_HEARD_MS reads
   *  a FAIR ONLY game again before it reveals (design §8.5 N1, settling). */
  private lastTick = new Map<string, number>();

  constructor(private readonly secret: Uint8Array) {
    this.pub = housePubOf(secret);
  }

  /** A restart of the node: what it saw is gone, what it revealed is on disk
   *  (house.rs keeps `done` in its state file). */
  restart(): void {
    this.rooms = new Map();
    this.verdicts = new Map();
    this.steppingDown = false;
    this.lastTick = new Map();
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

  /** Whether `k` is a house of room `room` under the deed holder's key
   *  `ownerKey` (house.rs house_of): this one, one pinned so, or one whose
   *  delegation (`hk:<k>`) the doc holds signed by them (pinned from then
   *  on). Asked only for the keys on house records: a delegation nothing
   *  names is never checked. */
  private houseOf(comp: Y.Map<unknown>, mem: RoomMem, room: string, ownerKey: string, k: string): boolean {
    if (k === this.pub || mem.houses.get(k) === ownerKey) return true;
    const v = comp.get(delegationKey(k));
    if (!isPlain(v) || !hasFields(v, ['v', 'h', 'k', 'g']) || v.v !== 1 || v.h !== k || v.k !== ownerKey) return false;
    if (!this.roomOk('hkey', room, '', v, ownerKey)) return false;
    mem.houses.set(k, ownerKey);
    return true;
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
        if ('trim' in w) {
          const { t, inc, key, value, ses, copies } = w.trim;
          if (!comp.has(key)) comp.set(key, value);
          for (const k of [...comp.keys()]) {
            if (k.startsWith(`ses:${t}:${inc}:`) || (k.startsWith(`ck:${t}:${inc}:`) && k !== key)) comp.delete(k);
          }
          // (An end opens no session: design §8.5 N6.)
          if (ses !== null) {
            const next = new Y.Map<unknown>();
            comp.set(ses, next);
            for (const [k, v] of copies) next.set(k, v);
          }
        } else if ('newSession' in w) {
          if (!(comp.get(w.newSession) instanceof Y.Map)) comp.set(w.newSession, new Y.Map());
        } else if (w.ses === null) {
          comp.set(w.key, w.value);
        } else {
          (comp.get(w.ses) as Y.Map<unknown> | undefined)?.set(w.key, w.value);
        }
      }
    }, HOUSE_ORIGIN);
    for (const k of Object.keys(out) as (keyof HouseTickOut)[]) this.wrote[k] += out[k];
    return out;
  }

  private plan(room: string, doc: Y.Doc, now: number, wall: number, out: HouseTickOut): Write[] {
    const writes: Write[] = [];
    const comp = doc.getMap('casinoComputed');
    let mem = this.rooms.get(room);
    if (!mem) {
      this.rooms.set(room, mem = { pins: new Map(), delegation: null, houses: new Map(), fair: new Map(), tables: new Map(), lastBeat: null, beatN: 0, lastReput: null });
    }
    // 🔒 Cut off for HOUSE_HEARD_MS (no tick: the sim ticks it only while its
    // page hears the room): it settles at each FAIR ONLY game again, so it
    // reads before it reveals (design §8.5 N1).
    const last = this.lastTick.get(room);
    this.lastTick.set(room, now);
    if (last !== undefined && now - last >= HOUSE_HEARD_MS) for (const table of mem.tables.values()) if (table.fo) table.firstRead = now;

    // The room's house tables (r/d), while the deed holder delegates this house.
    const rd = this.houseTables(room, doc, comp, mem, now, writes, out);
    // 🔒 The FAIR ONLY games it is the house of, whoever holds the deed.
    const fo = this.games(room, doc, comp, mem, now, writes, out);
    const fairTables = (rd?.fair ?? 0) + fo.settled;

    // The heartbeat, while a table runs Fair. 🔒 And not while it settles at
    // any game it serves: the beat is the room's, so a page at that game
    // would hear it and close at once, and a close first read while settling
    // is never revealed for. (The other tables go without a beat for
    // SETTLE_MS at most, well inside HOUSE_HEARD_MS.)
    if (fairTables > 0 && fo.settled === fo.serving && !this.steppingDown && (mem.lastBeat === null || now - mem.lastBeat >= HEARTBEAT_MS)) {
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
      if (rd) {
        if (!same(rd.delegNow, rd.delegation)) {
          writes.push({ ses: null, key: delegationKey(this.pub), value: rd.delegation });
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
      }
      for (const table of mem.tables.values()) {
        // (A house table's, only while this house is the room's.)
        if (!table.fo && !rd) continue;
        for (const [ses, key, value] of table.written) {
          // There as it wrote it: junk under its key reads as nothing on
          // every page, and goes too.
          const m = comp.get(ses);
          const present = m instanceof Y.Map ? same(m.get(key), value) : true;
          if (!present && !writes.some((w) => 'ses' in w && w.ses !== null && w.key === key)) {
            writes.push({ ses, key, value });
            out.putBacks += 1;
          }
        }
      }
      // 🔒 A game's checkpoint, session map and delegation (design §8.5 N5).
      for (const w of fo.reput) {
        if ('newSession' in w) this.newSessions += 1;
        else if ('ses' in w && w.key.startsWith('ck:')) this.rowPutBacks += 1;
        else out.putBacks += 1;
        writes.push(w);
      }
    }
    return writes;
  }

  /** The room's house tables (`r`/`d`), their reveals, step-downs and joins
   *  planned: null while this house is none of the room's (no deed holder
   *  known, or no delegation of this house's key by them). */
  private houseTables(room: string, doc: Y.Doc, comp: Y.Map<unknown>, mem: RoomMem, now: number, writes: Write[], out: HouseTickOut): { fair: number; delegNow: unknown; delegation: Record<string, unknown> } | null {
    const owner = doc.getMap('roomInfo').get('owner');
    if (typeof owner !== 'string' || owner === '' || owner === 'Local-Clone') return null;
    const roomMem = mem;
    const ownerKey = this.pinOf(roomMem, doc, owner);
    if (ownerKey === undefined) return null;

    // The delegation: this house's key, signed by the deed holder.
    const delegKey = delegationKey(this.pub);
    const delegNow = comp.get(delegKey) as Record<string, unknown> | undefined;
    let delegation = mem.delegation && mem.delegation.k === ownerKey ? mem.delegation : null;
    if (!delegation && isPlain(delegNow) && hasFields(delegNow, ['v', 'h', 'k', 'g']) && delegNow.v === 1 && delegNow.h === this.pub
      && delegNow.k === ownerKey && this.roomOk('hkey', room, '', delegNow, ownerKey)) {
      delegation = delegNow;
    }
    if (!delegation) return null;
    mem.delegation = delegation;

    // Every house the deed holder delegated (another of their nodes is a
    // house of the room as this one is, and its records hold the line, the
    // joins and the step-downs as this one's do) counts as its records come:
    // readTable asks houseOf.

    // The switched-on house tables, live.
    const casino = doc.getMap('casino');
    const tables: [string, string][] = [];
    for (const [key, v] of casino.entries()) {
      if (!key.startsWith('cfg:computed:')) continue;
      const t = key.slice('cfg:computed:'.length);
      if (!isPlain(v) || Object.keys(v).length !== 2 || v.v !== 1 || typeof v.inc !== 'string') continue;
      const inc = v.inc;
      if (!/^[ckrd][0-9a-f]{24}$/.test(inc) || !houseRules(inc) || casino.has(`gone:${t}:${inc}`)) continue;
      tables.push([t, inc]);
    }
    tables.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));

    // The owner's Fair setting of each of them, the one standing over every
    // other seen (fairAfter; a new deed holder's count afresh: the last
    // one's settings go).
    for (const [t, v] of mem.fair) if (v.k !== ownerKey) mem.fair.delete(t);
    for (const [t] of tables) {
      const v = comp.get(`hf:${t}`);
      if (!isPlain(v) || !hasFields(v, ['v', 'm', 's', 'k', 'g']) || v.v !== 1 || (v.m !== 0 && v.m !== 1) || !isRound(v.s) || v.k !== ownerKey) continue;
      const seen = mem.fair.get(t);
      if (seen !== undefined && !fairAfter(v as unknown as FairSettingRec, seen as unknown as FairSettingRec)) continue;
      if (this.roomOk('hfair', room, t, v, ownerKey)) mem.fair.set(t, v);
    }

    let fair = 0;
    for (const [t, inc] of tables) {
      const ctx: FoldCtx = { room, t, inc };
      const cp = asCheckpointFor(ctx)(comp.get(`sum:${t}:${inc}`));
      if (cp?.e === 1) continue;
      const read = this.readTable(comp, ctx, { u: cp?.u ?? 0, h: cp?.h, sid: nextSid(ctx, cp) }, (k) => this.houseOf(comp, roomMem, room, ownerKey, k));
      if (!read) continue;
      const friendly = mem.fair.get(t)?.m === 1;
      if (!friendly) fair += 1;
      this.tableDuties(mem, read, friendly, now, writes, out);
    }

    return { fair, delegNow, delegation };
  }

  /** 🔒 The FAIR ONLY games of the room this house serves (design §8.5 N1 to
   *  N5): each game's records resolved as a page resolves them (computedFairOnlyAuth, which
   *  the node's walk is a port of), its live session read from the base the
   *  resolution chose, and served while this house's key is delegated by the
   *  key that holds the game for the rounds after the base. Under an end order
   *  it reveals with no next commitment, steps down and joins nothing (N6's
   *  first part; the ended checkpoint is endDuty's). `reput`: what
   *  the doc lost, for the put-back's turn. `settled`: how many of them it has
   *  settled at, which are the ones it beats for: a page that hears the house
   *  again closes its round at once, and a close the house first reads while
   *  it settles is one it never reveals (the bettors would have to abandon
   *  it: a voided round and half a minute at every return of the house). So
   *  it is heard at a game only once it is ready to reveal there. */
  private games(room: string, doc: Y.Doc, comp: Y.Map<unknown>, mem: RoomMem, now: number, writes: Write[], out: HouseTickOut): { settled: number; serving: number; reput: Write[] } {
    const reput: Write[] = [];
    const byGame = new Map<string, { t: string; inc: string; cks: [string, unknown][]; xfs: [string, unknown][]; fin: unknown }>();
    const gameAt = (t: string, inc: string) => {
      const key = `${t}|${inc}`;
      let g = byGame.get(key);
      if (!g) byGame.set(key, g = { t, inc, cks: [], xfs: [], fin: undefined });
      return g;
    };
    const delegations: unknown[] = [];
    for (const [key, v] of comp.entries()) {
      if (key.startsWith('hk:')) {
        delegations.push(v);
        continue;
      }
      if (!key.startsWith('ck:') && !key.startsWith('xf:') && !key.startsWith('fin:')) continue;
      const pk = parseFairOnlyKey(key);
      if (!pk || pk.kind === 'do') continue;
      const g = gameAt(pk.t, pk.inc);
      if (pk.kind === 'ck') g.cks.push([key, v]);
      else if (pk.kind === 'xf') g.xfs.push([key, v]);
      else g.fin = v;
    }
    // (A game the doc holds nothing of any more, whose last checkpoint it signed.)
    for (const [at, row] of this.rows) {
      if (!at.startsWith(`${room}|`)) continue;
      const pk = parseFairOnlyKey(row.key);
      if (pk?.kind === 'ck') gameAt(pk.t, pk.inc);
    }
    const partial = (doc.store as unknown as { pendingStructs: unknown }).pendingStructs !== null;
    let settled = 0;
    let serving = 0;
    for (const key of [...byGame.keys()].sort()) {
      const { t, inc, cks, xfs, fin } = byGame.get(key)!;
      const row = this.rows.get(`${room}|${t}|${inc}`);
      const rec: AuthRecords = { cks: row ? [...cks, [row.key, row.value]] : cks, xfs, fin, delegations };
      const res = resolveGame({ room, sig: (id, pub, bytes, sig) => this.verified(['auth', room, id, '', ''], pub, bytes, sig) }, t, inc, rec);
      // N5: its last checkpoint, gone from the doc or with something else under
      // its key, while no authority's stands above it.
      const held = row ? comp.get(row.key) : undefined;
      if (row && !(isPlain(held) && recHash(held) === recHash(row.value)) && res.base?.key === row.key) reput.push({ ses: null, key: row.key, value: row.value as unknown as Record<string, unknown> });
      if (res.newer || res.pending || !res.live || !res.base) continue;
      const B = res.base.ck;
      const by = res.houseBy(this.pub, B.u + 1);
      if (!by) continue;
      serving += 1;
      const ctx: FoldCtx = { room, t, inc };
      const sid = nextSid3(ctx, B);
      const sesKey = `ses:${t}:${inc}:${sid}`;
      if (!(comp.get(sesKey) instanceof Y.Map)) {
        // (Not while the doc holds part of an update: the map may be in the part to come.)
        if (!partial) reput.push({ newSession: sesKey });
        continue;
      }
      // (Its delegation under its key, where the doc holds none of this house
      // there: nothing, or something that is no delegation of it. One of it
      // that differs from the root's stays: the deed holder's newer one.)
      const dNow = comp.get(delegationKey(this.pub));
      if (!(isPlain(dNow) && hasFields(dNow, ['v', 'h', 'k', 'g']) && dNow.v === 1 && dNow.h === this.pub)) {
        reput.push({ ses: null, key: delegationKey(this.pub), value: by.value as unknown as Record<string, unknown> });
      }
      const read = this.readTable(comp, ctx, { u: B.u, h: B.h, sid }, (k, r) => res.houseAt(k, r) === true);
      if (!read) continue;
      this.tableDuties(mem, read, res.fin !== null, now, writes, out);
      if (now - mem.tables.get(`${t}|${inc}`)!.firstRead >= SETTLE_MS) settled += 1;
      // 🔒 No checkpoint from a doc that holds part of an update (Yjs parks
      // what came out of order): a close, or a frozen slip a page is putting
      // back, may be in the part to come, and a trim, a sweep or an end
      // deletes the session it would land in. As a page's own trim waits for
      // its doc to be whole.
      if (partial) continue;
      if (res.fin === null) this.trimDuty(doc, mem, { ctx, res, base: res.base, dl: by.value, sesKey }, read, now, writes);
      else this.endDuty(doc, mem, { ctx, res, base: res.base, dl: by.value, sesKey }, read, res.fin, now, writes);
    }
    return { settled, serving, reput };
  }

  /** Table ctx's live session, the one `base` opens, as house.rs read_table
   *  reads it (null with none). `houseAt`: whether a key is a house that
   *  decides a round: at a house table the deed holder's delegations make
   *  them (houseOf), whatever the round; at a FAIR ONLY game the resolution's
   *  (the key that holds the game for the round delegated it). 🔒 And at a
   *  FAIR ONLY game the fold's rules there (computedFold S6): a close that
   *  names no commitment is junk (a), as is one more than MAX_HELD_ROUNDS
   *  past the base (b), and an abandon counts only from the key of a frozen
   *  slip of its close that is there and good (d). (Not (e), the cap on a
   *  game's players: the trim's fold has it, and a close past it is revealed
   *  for nothing.) */
  private readTable(comp: Y.Map<unknown>, ctx: FoldCtx, base: Base, houseAt: (k: string, r: number) => boolean): TableRead | null {
    const fo = isFairOnlyInc(ctx.inc);
    const { sid } = base;
    const sesKey = `ses:${ctx.t}:${ctx.inc}:${sid}`;
    const ses = comp.get(sesKey);
    if (!(ses instanceof Y.Map)) return null;
    const asSlip = asSlipFor(ctx);
    const read: TableRead = {
      ctx, sid, baseU: base.u, cpH: base.h, sesKey, slips: new Map(), seeds: new Map(), closes: [], top: base.u, abandoned: new Set(),
      reveals: [], joins: [], keys: (ses as Y.Map<unknown>).size,
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
          if (fo && (v.h === undefined || pk.r > base.u + MAX_HELD_ROUNDS)) break;
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
          if (gOk && k !== undefined && houseAt(k, pk.r)) houseRecs.push([pk.kind, pk.r, pk.h, v, k]);
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
      if (fo && !this.frozenKey(read, read.closes.find((c) => c.hash === x)!, k)) continue;
      if (this.abandonOk(ctx, r, k, v)) read.abandoned.add(x);
    }
    return read;
  }

  private slipOk(ctx: FoldCtx, hash: string, s: Slip): boolean {
    return this.verified(['slip', ctx.room, ctx.t, ctx.inc, hash], s.k, () => signBytes('slip', ctx, s.v), s.v.g as string);
  }

  /** 🔒 Whether `k` signed a frozen slip of close c that is there and good
   *  (computedFold S6 (d): only such a key's abandon counts at a FAIR ONLY game). */
  private frozenKey(read: TableRead, c: Close, k: string): boolean {
    const craps = gameOfInc(read.ctx.inc) === 'craps';
    return c.f.some(([p, sh]) => {
      const s = read.slips.get(sh);
      return s !== undefined && s.pid === p && s.r === c.r && s.k === k && (craps || s.chips) && this.slipOk(read.ctx, sh, s);
    });
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
    const craps = gameOfInc(ctx.inc) === 'craps';
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
      const fo = isFairOnlyInc(ctx.inc);
      for (const [x, r, k, v] of abandons) {
        if (x === c.hash && r === c.r && (!fo || this.frozenKey(read, c, k)) && this.abandonOk(ctx, r, k, v)) {
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
    const fo = isFairOnlyInc(ctx.inc);
    const tkey = `${ctx.t}|${ctx.inc}`;
    let mem = room.tables.get(tkey);
    if (!mem) {
      room.tables.set(tkey, mem = {
        firstSeen: new Map(), blocked: new Set(), seedSeen: new Map(), refused: new Set(), written: [], firstRead: now,
        fo, decidedAt: new Map(), missingAt: new Map(), keys: read.keys, lastNewKey: now, lastFold: null, kept: 0, lastSweep: null, carried: null, shortAt: null,
      });
      // After a start: its reveals from before go back as this run's do.
      for (const k of this.lastOf(ctx)?.kept ?? []) mem.written.push([k.ses, k.key, k.rec]);
    }
    if (read.keys !== mem.keys) {
      mem.keys = read.keys;
      mem.lastNewKey = now;
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
          // 🔒 At a FAIR ONLY game only a close first seen while settling is
          // blocked (design B2): an abandon, or a later close, would let anyone
          // hold the house off a round, which there nobody else can decide.
          if (settling || (!fo && (read.abandoned.has(c.hash) || read.top > r))) {
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
      mem.decidedAt.set(best.hash, now);
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
    // (one house to a round: two would let a bettor see both outcomes). Past a
    // checkpoint, that is the checkpoint's say (outstanding). (Its own
    // commitment, though, is `carried` whatever the checkpoint says: a
    // step-down a trim dropped still opened the seed, and a house with no
    // memory of it must not join that round on the commitment again.)
    if (joinsAt(read, r).length > 0 || outstanding(read, r)) return;
    if (mem.written.some(([, k]) => k.startsWith(`o:${r}:`))) return;
    const before = this.commit(ctx, r - 1);
    const toReveal = r - 1 > done && !mem.refused.has(r - 1)
      && closesAt(r - 1).some((c) => c.h === before && !mem!.blocked.has(c.hash));
    if (toReveal) return;
    this.writeSession(mem, read.sesKey, 'o', r, this.signed('hcommit', ctx, { r, c: this.commit(ctx, r), k: this.pub }), writes);
    out.joins += 1;
  }

  /** 🔒 A game's live session folded by the pages' fold (the node's engine
   *  is the same fold: fold.min.js, held to it by the shared vectors), from
   *  the base and with the houses its resolution gives, each player's felt
   *  under the key this house first saw them with. */
  private foldOf(doc: Y.Doc, room: RoomMem, g: Game): FoldResult {
    const { ctx } = g;
    const tf = new TableFold(
      ctx, (hash, kind, pub, bytes, sig) => this.verified([kind, ctx.room, ctx.t, ctx.inc, hash], pub, bytes, sig),
      (pid) => this.pinOf(room, doc, pid), foldGameOf(ctx), (pub, r) => g.res.houseAt(pub, r),
    );
    tf.setFairOnlyBase(g.base.ck);
    const ses = doc.getMap('casinoComputed').get(g.sesKey) as Y.Map<unknown>;
    tf.reset([...ses.entries()].map(([k, v]): [string, unknown] => [k, v === undefined ? null : v]));
    return tf.result();
  }

  /** 🔒 The trim of a FAIR ONLY game (design §8.5 N3, N4), on the node's
   *  clock. With no close past the last decided round D, D past the base and
   *  decided by this house's own reveal (as its state file has it) or by a
   *  bettor's abandon, every decided round's frozen slips in (or missing for
   *  MISSING_WAIT_MS), and HOUSE_TRIM_AFTER_MS since D was decided; under
   *  pressure: the session long, heavy, at craps a seven-out with the hand
   *  run long, the room's games heavy together, junk piled up, or idle. The checkpoint's
   *  content is the fold's; what this house knows of round D without it (the
   *  session, the round, the close its reveal listed, that reveal and the
   *  commitment it carried) must agree, and the record must read as a page
   *  reads one, or it signs nothing (the cross-check). Then Write::Trim. And
   *  neither it nor the sweep while the session reads short of a round this
   *  house revealed (readsShort). */
  private trimDuty(doc: Y.Doc, room: RoomMem, g: Game, read: TableRead, now: number, writes: Write[]): void {
    const { ctx } = g;
    const B = g.base.ck;
    const mem = room.tables.get(`${ctx.t}|${ctx.inc}`);
    if (!mem) return;
    // (Nothing of its own into the session it would close, this tick.)
    if (writes.some((w) => 'ses' in w && w.ses === g.sesKey)) return;
    // (Nothing in the session: nothing to trim to, and nothing to sweep.)
    if (read.closes.length === 0 && read.keys === 0) return;
    if (mem.lastFold !== null && now - mem.lastFold < FOLD_EVERY_MS) return;
    mem.lastFold = now;
    const res = this.foldOf(doc, room, g);
    mem.kept = res.keptBytes;
    if (res.pending) return;
    // (Noted at every checked fold, a close of the open round in or not: a
    // wait that began for one loss must not stand in for the next.)
    const short = this.readsShort(g, res, mem, now);
    const waits = this.missingWaits(res, mem, now);
    if (res.tip) return;
    let D: RoundView | undefined;
    for (const v of res.rounds) if (v.decided) D = v;
    if (short) return;
    if (!D || D.r <= B.u) {
      this.sweepDuty(doc, g, read, res, mem, now, writes);
      return;
    }
    const done = this.lastOf(ctx);
    let own: Kept | undefined;
    if (D.house) {
      if (!done?.d || done.d[0] !== D.r || done.d[1] !== D.close) return;
      const key = `h:${D.r}:${D.house.hash}`;
      own = done.kept.find((k) => k.ses === g.sesKey && k.key === key);
      if (!own) return;
    } else if (!D.abandon) {
      return;
    }
    let at = mem.decidedAt.get(D.close);
    if (at === undefined) mem.decidedAt.set(D.close, at = now);
    if (waits || now - at < HOUSE_TRIM_AFTER_MS) return;
    let roomKept = 0;
    for (const table of room.tables.values()) if (table.fo) roomKept += table.kept;
    const craps = gameOfInc(ctx.inc) === 'craps';
    const pressed = D.r - B.u >= HOUSE_TRIM_ROUNDS
      || res.keptBytes >= HOUSE_TRIM_BYTES
      || (D.craps?.sevenOut === true && D.r - B.u >= HOUSE_SEVEN_OUT_MIN)
      || (roomKept >= HOUSE_ROOM_BYTES && res.keptBytes >= HOUSE_ROOM_MIN_BYTES)
      || res.rawBytes - res.keptBytes >= HOUSE_SWEEP_BYTES
      || now - mem.lastNewKey >= HOUSE_IDLE_MS;
    if (!pressed) return;
    const n: Record<string, string> = {};
    for (const [pid, net] of res.nets) n[pid] = net.toString();
    let body: Record<string, unknown> = {
      v: 1, ok: B.ok, j: B.j, rv: B.rv, ts: B.ts, b: res.base.sid, u: D.r, l: D.close,
      d: D.house ? `h:${D.house.hash}` : `z:${D.abandon!.hash}`,
      // (A round a house reveal voided, counting nobody, has no outcome.)
      ...(D.decided === 'house' ? { o: craps ? D.craps!.dice : D.pocket } : {}),
      n, ...(craps ? { s: res.carry } : {}), ...(res.required !== null ? { h: res.required } : {}),
      dl: g.dl, ...(B.x !== undefined ? { x: B.x } : {}), k: this.pub,
    };
    if (this.faultTrim) body = this.faultTrim(body);
    // The cross-check, before it signs.
    let agrees = body.b === read.sid && body.u === D.r && Object.keys(n).length <= MAX_TABLE_PIDS;
    if (own) {
      // (The commitment its reveal carried, unless it has stepped down since.)
      const carried = done!.r === D.r ? own.rec.c : undefined;
      agrees &&= body.l === done!.d![1] && body.d === `h:${recHash(own.rec)}` && body.h === carried;
    }
    const sealed = agrees ? this.sealAsBase(g, body) : null;
    if (!sealed) {
      this.crossCheckMismatches += 1;
      return;
    }
    const carried = D.deciderCopies ?? [];
    this.rows.set(`${ctx.room}|${ctx.t}|${ctx.inc}`, sealed);
    this.trims += 1;
    mem.carried = { base: sealed.key, keys: carried };
    writes.push({ trim: { t: ctx.t, inc: ctx.inc, key: sealed.key, value: sealed.value, ses: `ses:${ctx.t}:${ctx.inc}:${nextSid3(ctx, sealed.value)}`, copies: this.copiesOf(doc, g, res, carried) } });
  }

  /** Whether a decided round of the session folded as `res` has a frozen
   *  slip missing, and has for less than MISSING_WAIT_MS as this house read
   *  it. Noted at every checked fold, a close of the open round in or not:
   *  a slip that came back ends its wait, so one that goes again waits
   *  afresh. */
  private missingWaits(res: FoldResult, mem: TableMem, now: number): boolean {
    let waits = false;
    for (const v of res.rounds) {
      if (!v.decided || v.missing.length === 0) {
        mem.missingAt.delete(v.close);
        continue;
      }
      let since = mem.missingAt.get(v.close);
      if (since === undefined) mem.missingAt.set(v.close, since = now);
      if (now - since < MISSING_WAIT_MS) waits = true;
    }
    return waits;
  }

  /** 🔒 Whether game g's session, folded as `res`, reads short of a round
   *  this house itself revealed in it (its state file's last reveal: a round
   *  past the base whose reveal it wrote into this session), and has for less
   *  than MISSING_WAIT_MS. Records only come, so a round it decided that the
   *  fold no longer reads decided has lost a record it rests on: a frozen
   *  slip its reveal counted, deleted by the bettor who lost the round. With
   *  the round off the chain the session reads as one with nothing decided,
   *  which a sweep would close for good, and an end would end without the
   *  round: the bet back to the one who deleted, the winners unpaid. The
   *  pages that showed the round put the record back in their turns (their
   *  witness copies), within seconds; so no sweep, trim or end meanwhile, as a
   *  page's own trim holds (computedTable trimDuty, noteChain). If nobody has
   *  put it back by then nobody is left who can, and the round is void. */
  private readsShort(g: Game, res: FoldResult, mem: TableMem, now: number): boolean {
    const done = this.lastOf(g.ctx);
    const r = done?.d?.[0];
    // (As it decided it: under the close its reveal listed first. A round
    // that reads decided under another close, say one the closer laid in
    // beside the deleted slip and voided with their own abandon, is as short
    // of its round as one that reads undecided.)
    const stands = res.rounds.some((v) => v.r === r && !!v.decided && v.close === done!.d![1]);
    if (r === undefined || r <= g.base.ck.u || stands || !done!.kept.some((k) => k.ses === g.sesKey && k.key.startsWith(`h:${r}:`))) {
      mem.shortAt = null;
      return false;
    }
    if (mem.shortAt === null || mem.shortAt > now) mem.shortAt = now;
    return now - mem.shortAt < MISSING_WAIT_MS;
  }

  /** 🔒 The end of a FAIR ONLY game whose end order `fin` stands (design §8.5
   *  N6; its other half, reveals without a next commitment, the step-down and
   *  no join, is tableDuties'). With no round in flight (no tip, no close of
   *  the open round in: what the holder's page waits for too, computedTable
   *  fairQuiet), an ended checkpoint embedding the order, with the fold's
   *  nets and no carry, commitment or sweep count: at the last decided round
   *  D past the base, under a trim's conditions but its pressure (D decided
   *  by this house's own reveal or a bettor's abandon, every decided round's
   *  frozen slips in or missing for MISSING_WAIT_MS, HOUSE_TRIM_AFTER_MS
   *  since D was decided), else at the base's round with the base's `l`, `d`
   *  and `o`, at once. Cross-checked as a trim is. Then Write::Trim with no
   *  next session: the game's sessions and lower checkpoints go, the holder's
   *  own end at a lower round among them (the B4 race). */
  private endDuty(doc: Y.Doc, room: RoomMem, g: Game, read: TableRead, fin: FinRec, now: number, writes: Write[]): void {
    const { ctx } = g;
    const B = g.base.ck;
    const mem = room.tables.get(`${ctx.t}|${ctx.inc}`);
    if (!mem) return;
    // (Nothing of its own into the session it would close, this tick.)
    if (writes.some((w) => 'ses' in w && w.ses === g.sesKey)) return;
    if (mem.lastFold !== null && now - mem.lastFold < FOLD_EVERY_MS) return;
    mem.lastFold = now;
    const res = this.foldOf(doc, room, g);
    mem.kept = res.keptBytes;
    if (res.pending) return;
    // (Noted at every checked fold, as trimDuty notes it.)
    const short = this.readsShort(g, res, mem, now);
    const waits = this.missingWaits(res, mem, now);
    if (res.tip || res.openCloses.some((c) => c.state !== 'invalid')) return;
    let D: RoundView | undefined;
    for (const v of res.rounds) if (v.decided) D = v;
    if (short) return;
    const past = D !== undefined && D.r > B.u ? D : null;
    const done = this.lastOf(ctx);
    let own: Kept | undefined;
    if (past) {
      if (past.house) {
        if (!done?.d || done.d[0] !== past.r || done.d[1] !== past.close) return;
        const key = `h:${past.r}:${past.house.hash}`;
        own = done.kept.find((k) => k.ses === g.sesKey && k.key === key);
        if (!own) return;
      } else if (!past.abandon) {
        return;
      }
      let at = mem.decidedAt.get(past.close);
      if (at === undefined) mem.decidedAt.set(past.close, at = now);
      if (waits || now - at < HOUSE_TRIM_AFTER_MS) return;
    }
    const n: Record<string, string> = {};
    for (const [pid, net] of res.nets) n[pid] = net.toString();
    const craps = gameOfInc(ctx.inc) === 'craps';
    let body: Record<string, unknown> = {
      v: 1, ok: B.ok, j: B.j, rv: B.rv, ts: B.ts, b: res.base.sid,
      ...(past
        ? {
            u: past.r, l: past.close, d: past.house ? `h:${past.house.hash}` : `z:${past.abandon!.hash}`,
            // (A round a house reveal voided, counting nobody, has no outcome.)
            ...(past.decided === 'house' ? { o: craps ? past.craps!.dice : past.pocket } : {}),
          }
        : { u: B.u, l: B.l, ...(B.d !== undefined ? { d: B.d } : {}), ...(B.o !== undefined ? { o: B.o } : {}) }),
      n, e: 1, f: fin, dl: g.dl, ...(B.x !== undefined ? { x: B.x } : {}), k: this.pub,
    };
    if (this.faultTrim) body = this.faultTrim(body);
    // The cross-check, before it signs.
    let agrees = body.b === read.sid && body.u === (past ? past.r : B.u) && Object.keys(n).length <= MAX_TABLE_PIDS
      && body.s === undefined && body.h === undefined && body.w === undefined;
    if (own) agrees &&= body.l === done!.d![1] && body.d === `h:${recHash(own.rec)}`;
    const sealed = agrees ? this.sealAsBase(g, body) : null;
    if (!sealed) {
      this.crossCheckMismatches += 1;
      return;
    }
    this.rows.set(`${ctx.room}|${ctx.t}|${ctx.inc}`, sealed);
    this.ends += 1;
    mem.carried = null;
    writes.push({ trim: { t: ctx.t, inc: ctx.inc, key: sealed.key, value: sealed.value, ses: null, copies: [] } });
  }

  /** 🔒 The sweep (design §8.5 N3s): no round decided since the base, no close
   *  of the open round, and junk piled up in the session (HOUSE_SWEEP_BYTES of
   *  what the fold does not use, or HOUSE_SWEEP_KEYS keys of it). The base's
   *  content signed again by this house with one sweep more, closing the
   *  junked session: a checkpoint of the same round that outranks the base
   *  (S3) and opens a session of its own, into which go what a trim would
   *  carry: the open round's felts and joins, and the copies of round u the
   *  swept session held. Cross-checked as a trim is; at most one per
   *  HOUSE_SWEEP_MIN_MS. A trim sweeps too, so this is only for a session
   *  with nothing decided in it. */
  private sweepDuty(doc: Y.Doc, g: Game, read: TableRead, res: FoldResult, mem: TableMem, now: number, writes: Write[]): void {
    const { ctx } = g;
    const B = g.base.ck;
    if (mem.lastSweep !== null && now - mem.lastSweep < HOUSE_SWEEP_MIN_MS) return;
    // Round u's decider, and the reveals its trim copied with it (a house
    // that restarted since carries the decider alone: the rest is for show).
    // Each is what its key says, or is junk as any other key is: junk a peer
    // wrote over one would else ride every sweep and press the next, and
    // would not be counted among the keys this sweep clears. What is carried
    // is no junk by its weight either (the fold keeps none of round u, so
    // `rawBytes - keptBytes` holds it): a sweep would clear none of it, and
    // a round whose records weigh HOUSE_SWEEP_BYTES would be swept every
    // HOUSE_SWEEP_MIN_MS for nothing.
    const ses = doc.getMap('casinoComputed').get(g.sesKey) as Y.Map<unknown>;
    const carried: string[] = [];
    let carriedBytes = 0;
    for (const key of mem.carried?.base === g.base.key ? mem.carried.keys : B.d === undefined ? [] : [`${B.d.slice(0, 1)}:${B.u}:${B.d.slice(2)}`]) {
      const v = ses.get(key);
      let hash: string | null = null;
      try {
        hash = recHash(v);
      } catch {
        hash = null;
      }
      if (hash === null || hash !== key.slice(key.lastIndexOf(':') + 1)) continue;
      carried.push(key);
      carriedBytes += key.length + canon(v)!.length;
    }
    const junkKeys = read.keys - res.felts.size - res.joins.length - carried.length;
    if (res.rawBytes - res.keptBytes - carriedBytes < HOUSE_SWEEP_BYTES && junkKeys < HOUSE_SWEEP_KEYS) return;
    const { g: _sig, e: _e, f: _f, ...content } = B;
    let body: Record<string, unknown> = { ...content, b: read.sid, w: (B.w ?? 0) + 1, dl: g.dl, k: this.pub };
    if (this.faultTrim) body = this.faultTrim(body);
    // The cross-check: the session it closes, one sweep on, this house's under
    // its delegation, and for the rest the base's content, field for field.
    const { b: b_, w: w_, dl: dl_, k: k_, ...rest } = body;
    const { b: _b, w: _w, dl: _dl, k: _k, ...held } = content;
    let agrees = false;
    try {
      agrees = b_ === read.sid && w_ === (B.w ?? 0) + 1 && k_ === this.pub && recHash(dl_) === recHash(g.dl) && recHash(rest) === recHash(held);
    } catch {
      agrees = false;
    }
    const sealed = agrees ? this.sealAsBase(g, body) : null;
    if (!sealed) {
      this.crossCheckMismatches += 1;
      return;
    }
    this.rows.set(`${ctx.room}|${ctx.t}|${ctx.inc}`, sealed);
    this.sweeps += 1;
    mem.lastSweep = now;
    mem.carried = { base: sealed.key, keys: carried };
    writes.push({ trim: { t: ctx.t, inc: ctx.inc, key: sealed.key, value: sealed.value, ses: `ses:${ctx.t}:${ctx.inc}:${nextSid3(ctx, sealed.value)}`, copies: this.copiesOf(doc, g, res, carried) } });
  }

  /** A checkpoint body signed, if it reads as a page reads one and is the
   *  best of the game with it in (else no page would count from it); else null. */
  private sealAsBase(g: Game, body: Record<string, unknown>): { key: string; value: CkRec } | null {
    const { ctx } = g;
    let sealed: { key: string; value: CkRec };
    try {
      sealed = sealCk(ctx, body as unknown as Omit<CkRec, 'g'>, (bytes) => houseSign(this.secret, bytes));
    } catch {
      return null;
    }
    const with_: AuthRecords = { cks: [[g.base.key, g.base.ck], [sealed.key, sealed.value]], xfs: [], delegations: [g.dl] };
    const after = resolveGame({ room: ctx.room, sig: (id, pub, bytes, sig) => this.verified(['auth', ctx.room, id, '', ''], pub, bytes, sig) }, ctx.t, ctx.inc, with_);
    return after.base?.key === sealed.key ? sealed : null;
  }

  /** What a trim or a sweep carries into the session it opens (the L7 copies):
   *  the open round's felts whose seed is not out, the house's joins of it,
   *  and round u's decider with the reveals it counted (`carried`). */
  private copiesOf(doc: Y.Doc, g: Game, res: FoldResult, carried: string[]): [string, unknown][] {
    const ses = doc.getMap('casinoComputed').get(g.sesKey) as Y.Map<unknown>;
    const copies: [string, unknown][] = [];
    const copy = (key: string): void => {
      const v = ses.get(key);
      if (v !== undefined && !copies.some(([k]) => k === key)) copies.push([key, v]);
    };
    for (const s of res.felts.values()) if (!res.revealedCommits.has(s.rec.c)) copy(s.key);
    for (const j of res.joins) copy(`o:${res.open}:${j.hash}`);
    for (const key of carried) copy(key);
    return copies;
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

/** Whether some house's commitment is still outstanding at round r: the one
 *  a close of r must name, as the pages' fold takes it. After a reveal of
 *  round r - 1 that carried one, it is that one, unless a step-down at r
 *  opened it. At the first round past a checkpoint it is the checkpoint's `h`
 *  and no reveal in the session: a trim copies round u's house reveal into the
 *  next session, but not a step-down at u + 1 that lifted the commitment the
 *  reveal carried, and then writes no `h`, so the copy would make a lifted
 *  commitment look outstanding (and one that a v0.50 trim did not copy, a
 *  missing one). */
function outstanding(read: TableRead, r: number): boolean {
  if (r === read.baseU + 1) return read.cpH !== undefined && !steppedDown(read, r, read.cpH);
  return read.reveals.some((h) => h.r === r - 1 && h.c !== undefined && !steppedDown(read, r, h.c));
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
