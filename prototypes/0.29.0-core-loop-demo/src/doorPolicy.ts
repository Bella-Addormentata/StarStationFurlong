/**
 * 🚦 Per-door permissions + rights requests (#67 D1/D1b)
 *
 * Three shared maps in the room doc (rebind per join, T0 seam, exactly the
 * doorsDoc pattern):
 *  - `doorPolicy`   : door id → { passage, construction } — the owner's rules.
 *  - `doorRequests` : `${doorId}|${pub}` → a player's plea for build rights.
 *  - `doorGrants`   : `${doorId}|${pub}` → a standing, revocable grant.
 *
 * MODES. passage: 'public' (default — today's behavior, anyone opens/closes/
 * walks) | 'owner'. construction: 'owner' (default — the v0.30.7 gate) |
 * 'request' (anyone may ASK; owner approves into a grant) | 'public'.
 *
 * Grants are keyed to IDENTITY PUBKEYS (base64url Ed25519, keypair.ts), not
 * ephemeral player ids — a grant survives leave/rejoin and ties into the
 * contacts system. This is the game's first owner-mediated social contract;
 * the same plumbing generalizes to co-host designation (durability C1) later.
 *
 * POLICY LIVES HERE, NOT ON DoorRecord: pairing records are deleted on unpair
 * (the one-way-vestibule investigation's lesson) — policy must survive that.
 *
 * Enforcement posture (dev phase, same as edit mode / the docking owner gate):
 * WRITE-side is UI-gated (owner-only controls), READ-side is shape-validated
 * but not cryptographically verified — signed records are #67 D3.
 */

import * as Y from 'yjs';
import { LEGACY_ID_WALL, doorExistsIn, hasDoorLayout, isDoorLayoutRecord } from './doorLayoutDoc';

export type PassageMode = 'public' | 'owner';
export type ConstructionMode = 'owner' | 'request' | 'public';

export interface DoorPolicyRecord {
  passage: PassageMode;
  /** 🚪↦ ONE-WAY travel (owner request): with passage 'public', 'in' lets
   *  guests only ENTER through this door (their departures are refused);
   *  'out' lets guests only EXIT (their arrivals bounce off the turnstile).
   *  Absent = two-way. Owner-equivalents always pass BOTH ways. */
  oneWay?: 'in' | 'out';
  construction: ConstructionMode;
  /** #67 D2: a 🔌 Docking Adapter is INSTALLED at this door — anyone may
   *  TRANSIENTLY berth a ship module here (no chains, no station-graph
   *  permanence, either side detaches). Owner installs/removes (consumes/
   *  refunds an ADAPTER part). */
  adapter?: boolean;
  /** ⚓🚦 The port's GATE number (airport-style, 1..MAX_GATE), shown on
   *  departure boards and tried in order by arriving ships. Stored, never
   *  derived, so gates never renumber as other ports come and go: assigned
   *  the lowest free number in the station when the port is fitted, editable
   *  by the owner at the door panel, cleared when the port is removed. Only
   *  meaningful while `adapter` is true. */
  gate?: number;
  /** ⚓🚦 Who may dock at this gate — the station owner's choice, shown to
   *  captains and enforced by the far end of every DOCK (dockRules
   *  farDockPatch refuses `not-allowed`). Absent = 'open'. Only meaningful
   *  while `adapter` is true. */
  gateAccess?: GateAccess;
  /** With `gateAccess: 'reserved'`: the one ship (its ROOM id) that may dock
   *  here — an airline's own gate. A room id, never a pass. */
  reservedFor?: string;
  /** 🚏🤖 The owner lets this gate DOCK SCHEDULED FERRIES AUTOMATICALLY: a
   *  game in this room docks a route ferry the gate admits when it arrives
   *  and casts it off at its departure, with nobody aboard (gateKeeper.ts).
   *  Absent = off. Only meaningful while `adapter` is true. */
  autoFerry?: boolean;
}

/** ⚓🚦 open: any ship · pass: captains the owner granted at this door (the
 *  door panel's request/grant) · reserved: one named ship · closed: none. */
export type GateAccess = 'open' | 'pass' | 'reserved' | 'closed';
export const GATE_ACCESS: readonly GateAccess[] = ['open', 'pass', 'reserved', 'closed'];
const MAX_RESERVED_ID = 128;

/** The access fields of a stored value, or none (open). Peer-written, and
 *  read by the far end of every DOCK, so it fails closed: only no access at
 *  all, or an explicit 'open', opens the gate; a restriction it cannot read
 *  (an unknown value, a reservation naming no ship) closes it. */
function cleanAccess(raw: Partial<DoorPolicyRecord> | undefined): Pick<DoorPolicyRecord, 'gateAccess' | 'reservedFor'> {
  const a = raw?.gateAccess;
  if (a === undefined || a === 'open') return {};
  if (a === 'pass' || a === 'closed') return { gateAccess: a };
  if (a === 'reserved' && typeof raw?.reservedFor === 'string'
    && raw.reservedFor.length > 0 && raw.reservedFor.length <= MAX_RESERVED_ID) {
    return { gateAccess: 'reserved', reservedFor: raw.reservedFor };
  }
  return { gateAccess: 'closed' };
}

/** Highest gate number a port may carry. */
export const MAX_GATE = 99;

/** Is `v` a gate number? */
export function isGateNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_GATE;
}

/** The lowest gate number not in `taken` (1 when none are), or null when
 *  every number is used. */
export function nextFreeGate(taken: Iterable<number>): number | null {
  const used = new Set(taken);
  for (let g = 1; g <= MAX_GATE; g++) if (!used.has(g)) return g;
  return null;
}

export interface DoorRightsRequest {
  doorId: string;
  requesterPub: string;   // base64url Ed25519 identity key
  requesterName: string;
  at: number;
}

export interface DoorRightsGrant {
  doorId: string;
  pub: string;
  name: string;
  grantedAt: number;
}

export const DEFAULT_DOOR_POLICY: DoorPolicyRecord = { passage: 'public', construction: 'owner' };

const DOOR_IDS = ['north', 'south', 'east', 'west'] as const;

/**
 * 🚪 #91: policy is keyed by ANY door the room actually has — the 4 cardinal
 * berths plus every free door the editor placed (#28) — not by the cardinal
 * list alone, which silently dropped every write for a `d:` id and pinned its
 * canPass to "public". Unknown ids are still rejected, so a stale id can't
 * spawn a policy record.
 *
 * NOTE the WRITE side has no UI yet: free doors are passages with no terminal
 * (that keypad drove cardinal-only pose math and threw), so today nothing calls
 * writeDoorPolicy for one and a placed door is effectively public two-way. The
 * read side honouring free ids is what makes an affordance — the deferred #28
 * S6d work — a UI-only change rather than another store migration.
 */
function isKnownDoorId(doorId: string): boolean {
  if ((DOOR_IDS as readonly string[]).includes(doorId)) return true;
  return hasDoorLayout(doorId);
}

let boundDoc: Y.Doc | null = null;
let policyMap: Y.Map<unknown> | null = null;
let requestsMap: Y.Map<unknown> | null = null;
let grantsMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();
/** ⚓🚦 Listeners to the policy records alone (subscribeDoorPolicyRecords). */
const recordListeners = new Set<() => void>();

function notify(to: Set<() => void> = listeners): void {
  for (const l of [...to]) {
    try { l(); } catch (e) { console.error('[doorPolicy] listener threw:', e); }
  }
}

export function bindDoorPolicy(doc: Y.Doc): void {
  boundDoc = doc;
  policyMap = doc.getMap('doorPolicy');
  requestsMap = doc.getMap('doorRequests');
  grantsMap = doc.getMap('doorGrants');
  // The records' own listeners first: what they derive (the station's gates)
  // is current by the time the rest repaint.
  policyMap.observe(() => { notify(recordListeners); notify(); });
  requestsMap.observe(() => notify());
  grantsMap.observe(() => notify());
  notify(recordListeners);
  notify();
}

export function subscribeDoorPolicy(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** ⚓🚦 A listener to the policy records alone (a port fitted, removed or
 *  renumbered, a gate's access) and to a room being bound. A rights request
 *  or grant changes no gate, so it never calls this one. */
export function subscribeDoorPolicyRecords(listener: () => void): () => void {
  recordListeners.add(listener);
  return () => recordListeners.delete(listener);
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && policyMap !== null;
}

// ── Policy ───────────────────────────────────────────────────────────────────

/** Sanitized read; unknown/missing values fall back to the defaults. */
export function readDoorPolicy(doorId: string): DoorPolicyRecord {
  if (!docAlive() || !isKnownDoorId(doorId)) return { ...DEFAULT_DOOR_POLICY };
  return sanitizePolicy(policyMap!.get(doorId));
}

/** The read boundary for one stored policy value (peer-written, untrusted). */
function sanitizePolicy(value: unknown): DoorPolicyRecord {
  const raw = value as Partial<DoorPolicyRecord> | undefined;
  return {
    passage: raw?.passage === 'owner' ? 'owner' : 'public',
    ...(raw?.oneWay === 'in' || raw?.oneWay === 'out' ? { oneWay: raw.oneWay } : {}),
    construction: raw?.construction === 'request' || raw?.construction === 'public' ? raw.construction : 'owner',
    adapter: raw?.adapter === true,
    ...(raw?.adapter === true && isGateNumber(raw?.gate) ? { gate: raw.gate } : {}),
    ...(raw?.adapter === true ? cleanAccess(raw) : {}),
    ...(raw?.adapter === true && raw?.autoFerry === true ? { autoFerry: true } : {}),
  };
}

/** The one stored shape every policy writer produces. */
function policyShape(policy: DoorPolicyRecord): DoorPolicyRecord {
  return {
    passage: policy.passage,
    ...(policy.oneWay === 'in' || policy.oneWay === 'out' ? { oneWay: policy.oneWay } : {}),
    construction: policy.construction,
    adapter: policy.adapter === true,
    ...(policy.adapter === true && isGateNumber(policy.gate) ? { gate: policy.gate } : {}),
    ...(policy.adapter === true ? cleanAccess(policy) : {}),
    ...(policy.adapter === true && policy.autoFerry === true ? { autoFerry: true } : {}),
  };
}

/** ⚓🚦 A gate's access as the atlas carries it: absent when open. */
export interface GateAccessRecord {
  access: Exclude<GateAccess, 'open'>;
  reservedFor?: string;
}

function accessRecord(p: DoorPolicyRecord): GateAccessRecord | null {
  if (!p.adapter || !p.gateAccess || p.gateAccess === 'open') return null;
  return { access: p.gateAccess, ...(p.reservedFor ? { reservedFor: p.reservedFor } : {}) };
}

/** Most ports a gate read lists: more than a station has gate numbers. */
const MAX_PORTS = 256;
/** Most keys of each peer-written map a port scan looks at, junk included:
 *  a room's own doors, and the policies they leave, fit well inside (as
 *  doorsDoc bounds its pairing scan). */
const MAX_SCANNED_PORT_KEYS = 4 * MAX_PORTS;

/** ⚓🚦 The dock ports a room's layout has (doors whose policy fits an
 *  adapter), with their policies, for the gate readers. A port has a key in
 *  both peer-written maps, its door's layout record and its policy, and the
 *  scan reads a bounded number of keys from each. It walks the layout first,
 *  so stale or junk policy keys (a removed door's, a peer's) cannot crowd a
 *  live port out, and the policy map only when a flood cuts the layout walk
 *  short, so junk doors cannot either; doors without an adapter never count
 *  toward the port cap. A flood of both maps can keep a port off these lists,
 *  never off a DOCK at that door, which reads its own policy (gateAccessIn,
 *  dockPortFlagIn). */
function portsIn(doc: Y.Doc, policies: Y.Map<unknown>): Array<[string, DoorPolicyRecord]> {
  return scanPorts(doc, policies).ports;
}

/** portsIn, and whether it saw every port: not when a flood of both maps cut
 *  the scan short, nor when the room has more ports than the port cap. */
function scanPorts(doc: Y.Doc, policies: Y.Map<unknown>): { ports: Array<[string, DoorPolicyRecord]>; complete: boolean } {
  const layout = doc.getMap('doorLayout');
  const out = new Map<string, DoorPolicyRecord>();
  let full = false;
  const take = (id: string): void => {
    const p = sanitizePolicy(policies.get(id));
    if (!p.adapter) return;
    if (out.size >= MAX_PORTS) full = true;
    else out.set(id, p);
  };
  // A door is a valid record under its own id (doorExistsIn), which junk is
  // not: told apart here before doorExistsIn counts the whole map for it.
  const isDoor = (id: string): boolean => {
    const rec = layout.get(id);
    return isDoorLayoutRecord(rec) && rec.id === id && doorExistsIn(doc, id);
  };
  let any = false;
  let cut = false;
  let scanned = 0;
  for (const id of layout.keys()) {
    if (++scanned > MAX_SCANNED_PORT_KEYS) { cut = true; break; }
    if (isDoor(id)) { any = true; take(id); }
  }
  // Every port has a policy key: a policy walk that ends finds the ports the
  // layout walk was cut short of.
  let complete = true;
  if (cut) {
    scanned = 0;
    for (const id of policies.keys()) {
      if (++scanned > MAX_SCANNED_PORT_KEYS) { complete = false; break; }
      if (!out.has(id) && isDoor(id)) take(id);
    }
  } else if (!any) {
    // A legacy room keeps no layout records: its doors are the cardinal ones.
    for (const id of Object.keys(LEGACY_ID_WALL)) if (doorExistsIn(doc, id)) take(id);
  }
  return { ports: [...out], complete: complete && !full };
}

/** ⚓🚦 Every non-open gate access of this room's ports, by door id. */
export function readGateAccess(): Record<string, GateAccessRecord> {
  const out: Record<string, GateAccessRecord> = {};
  if (!docAlive()) return out;
  for (const [doorId, p] of portsIn(boundDoc!, policyMap!)) {
    const a = accessRecord(p);
    if (a) out[doorId] = a;
  }
  return out;
}

/** ⚓🚦 One door's gate access in ANY doc (the far room's, during a DOCK),
 *  with whether `pub` holds the owner's grant at that door. */
export function gateAccessIn(
  doc: Y.Doc, doorId: string, pub?: string,
): { access: GateAccess; reservedFor?: string; granted: boolean } {
  if ((doc as { isDestroyed?: boolean }).isDestroyed) return { access: 'open', granted: false };
  const a: { access: GateAccess; reservedFor?: string } =
    accessRecord(sanitizePolicy(doc.getMap('doorPolicy').get(doorId))) ?? { access: 'open' };
  const granted = !!pub && isGrantFor(doc.getMap('doorGrants').get(reqKey(doorId, pub)), doorId, pub);
  return { ...a, granted };
}

/** ⚓ #163: does this door of ANY doc wear a docking-adapter port? (The far
 *  room's end of a DOCK reads it — dockRules.farDockPatch refuses a berth
 *  whose port was removed.) Sanitized exactly like readDoorPolicy. */
export function dockPortFlagIn(doc: Y.Doc, doorId: string): boolean {
  if ((doc as { isDestroyed?: boolean }).isDestroyed) return false;
  return sanitizePolicy(doc.getMap('doorPolicy').get(doorId)).adapter === true;
}

/**
 * ⚓ #163: fit a docking-adapter PORT on a door of ANY doc — the far room's
 * end of a DOCK (farDoorWrite.ts holds that doc for a moment; it is not the
 * bound one). Its other policy fields are kept exactly as stored; the caller
 * has already checked the door exists in that room's layout.
 */
export function fitDockPortIn(doc: Y.Doc, doorId: string, gate?: number | null): void {
  if ((doc as { isDestroyed?: boolean }).isDestroyed) return;
  const map = doc.getMap('doorPolicy');
  const current = sanitizePolicy(map.get(doorId));
  if (current.adapter) return;
  doc.transact(() => {
    map.set(doorId, policyShape({ ...current, adapter: true, ...(isGateNumber(gate) ? { gate } : {}) }));
  });
}

/** ⚓🚦 Every gate this room's ports carry, by door id — what the atlas
 *  harvest publishes for the station's boards and arriving ships. */
export function readDockGates(): Record<string, number> {
  const out: Record<string, number> = {};
  if (!docAlive()) return out;
  for (const [doorId, p] of portsIn(boundDoc!, policyMap!)) {
    if (p.gate !== undefined) out[doorId] = p.gate;
  }
  return out;
}

/** ⚓🚦 readDockGates and readGateAccess from one port scan, or null when the
 *  room's gates are not known: a port has no number yet (fitted before gates
 *  existed), or the scan may have left a port out (a flood of both
 *  peer-written maps cut it short, or more ports than a gate read lists). A
 *  list missing a port is no list of the room's gates: the atlas harvest
 *  would drop that gate for everyone. */
export function readDockGatesIfComplete(): { gates: Record<string, number>; gateAccess: Record<string, GateAccessRecord> } | null {
  if (!docAlive()) return null;
  const { ports, complete } = scanPorts(boundDoc!, policyMap!);
  if (!complete) return null;
  const gates: Record<string, number> = {};
  const gateAccess: Record<string, GateAccessRecord> = {};
  for (const [doorId, p] of ports) {
    if (p.gate === undefined) return null;
    gates[doorId] = p.gate;
    const a = accessRecord(p);
    if (a) gateAccess[doorId] = a;
  }
  return { gates, gateAccess };
}

/** ⚓🚦 This room's ports that carry no gate number yet (fitted before gates
 *  existed), by door id, in id order. */
export function readUnnumberedPorts(): string[] {
  const out: string[] = [];
  if (!docAlive()) return out;
  for (const [doorId, p] of portsIn(boundDoc!, policyMap!)) {
    if (p.gate === undefined) out.push(doorId);
  }
  return out.sort();
}

/** ⚓🚦 The gates this room's ports hold (readDockGates), for picking a
 *  number no other port has, and whether the read saw every port: not when
 *  the port scan may have left one out (a flood of both peer-written maps cut
 *  it short, or more ports than a gate read lists). The numbers it saw are
 *  taken either way; a number it did not see might be a hidden port's. */
export function readGatesInUse(): GatesInUse {
  return docAlive() ? gatesInUseIn(boundDoc!) : { gates: {}, complete: false, unnumbered: false };
}

/** ⚓🚦 readGatesInUse for ANY doc (the far room's, during a DOCK). */
export function gatesInUseIn(doc: Y.Doc): GatesInUse {
  if ((doc as { isDestroyed?: boolean }).isDestroyed) return { gates: {}, complete: false, unnumbered: false };
  const { ports, complete } = scanPorts(doc, doc.getMap('doorPolicy'));
  const gates: Record<string, number> = {};
  let unnumbered = false;
  for (const [doorId, p] of ports) {
    if (p.gate !== undefined) gates[doorId] = p.gate;
    else unnumbered = true;
  }
  return { gates, complete, unnumbered };
}

/** ⚓🚦 What readGatesInUse read: the gates by door id, whether that is
 *  every port of the room, and whether a port it saw has no number yet. */
export interface GatesInUse {
  gates: Record<string, number>;
  complete: boolean;
  unnumbered: boolean;
}

/** ⚓🚦 Whether a port fitted now may take a number: only while the room's
 *  gates are known, every port seen and numbered (the list its harvest
 *  publishes). Otherwise the harvest says the room's gates are not known, and
 *  the rest of the station could not see a number given here, so another new
 *  port there could take it too. The port is fitted unnumbered instead, and
 *  numbered with the room's other ports once the module's owner or a
 *  shareholder is in it. This is also why the station's rooms whose gates are
 *  not known hold no numbers to step over (freeGateNumber), apart from ports a
 *  flood hides. */
export function mayNumberNewPort(inUse: GatesInUse): boolean {
  return inUse.complete && !inUse.unnumbered;
}

/** 🚏🤖 Most layout keys readAutoFerryGates looks at, junk included: the
 *  gate keeper reads it once a second, and the map is any peer's to write.
 *  A room's own doors fit well inside. */
export const MAX_AUTO_FERRY_LAYOUT_KEYS = 256;

/** 🚏🤖 This room's ports whose owner lets them dock scheduled ferries
 *  automatically (`autoFerry`), with their policies, in door id order: the
 *  doors portsIn reads, over a walk of at most MAX_AUTO_FERRY_LAYOUT_KEYS
 *  layout keys. Null when the layout holds more: the list might leave a gate
 *  out, and the gate keeper then does nothing. */
export function readAutoFerryGates(): Array<{ doorId: string; policy: DoorPolicyRecord }> | null {
  if (!docAlive()) return [];
  const doc = boundDoc!;
  const out: Array<{ doorId: string; policy: DoorPolicyRecord }> = [];
  const take = (doorId: string): void => {
    const policy = sanitizePolicy(policyMap!.get(doorId));
    if (policy.adapter && policy.autoFerry === true) out.push({ doorId, policy });
  };
  let scanned = 0;
  let any = false;
  for (const [doorId, value] of doc.getMap('doorLayout').entries()) {
    if (++scanned > MAX_AUTO_FERRY_LAYOUT_KEYS) return null;
    // doorExistsIn, asked only of a well-formed record: of anything else it
    // would count the whole map.
    if (!isDoorLayoutRecord(value) || value.id !== doorId || !doorExistsIn(doc, doorId)) continue;
    any = true;
    take(doorId);
  }
  // A legacy room keeps no layout records: its doors are the cardinal ones.
  if (!any) for (const doorId of Object.keys(LEGACY_ID_WALL)) if (doorExistsIn(doc, doorId)) take(doorId);
  return out.sort((a, b) => (a.doorId < b.doorId ? -1 : a.doorId > b.doorId ? 1 : 0));
}

/** ⚓🚦 The gates of ANY doc's ports (the far room's, during a DOCK). */
export function dockGatesIn(doc: Y.Doc): Record<string, number> {
  const out: Record<string, number> = {};
  if ((doc as { isDestroyed?: boolean }).isDestroyed) return out;
  // Only doors the room's layout has: a peer's policy for a door that does
  // not exist must not use up gate numbers.
  for (const [doorId, p] of portsIn(doc, doc.getMap('doorPolicy'))) {
    if (p.gate !== undefined) out[doorId] = p.gate;
  }
  return out;
}

/** Player-facing passage label (plain language, one string everywhere). */
export function passageLabel(policy: DoorPolicyRecord): string {
  if (policy.passage === 'owner') return 'OWNER';
  if (policy.oneWay === 'in') return 'PUBLIC · IN ONLY';
  if (policy.oneWay === 'out') return 'PUBLIC · OUT ONLY';
  return 'PUBLIC';
}

/** Owner UI only (write-side gating is the caller's job — see module header). */
export function writeDoorPolicy(doorId: string, policy: DoorPolicyRecord): void {
  if (!docAlive() || !isKnownDoorId(doorId)) return;
  boundDoc!.transact(() => {
    policyMap!.set(doorId, policyShape(policy));
  });
}

// ── Requests ─────────────────────────────────────────────────────────────────

function reqKey(doorId: string, pub: string): string {
  return `${doorId}|${pub}`;
}

function isRequest(v: unknown): v is DoorRightsRequest {
  const r = v as Partial<DoorRightsRequest> | null;
  return !!r && typeof r.doorId === 'string' && typeof r.requesterPub === 'string'
    && !!r.requesterPub && typeof r.requesterName === 'string' && typeof r.at === 'number';
}

/** A player asks for build rights at a door (their own client writes it). */
export function writeDoorRequest(doorId: string, pub: string, name: string): void {
  if (!docAlive() || !pub) return;
  boundDoc!.transact(() => {
    requestsMap!.set(reqKey(doorId, pub), {
      doorId, requesterPub: pub, requesterName: name || 'Unknown-Clone', at: Date.now(),
    } satisfies DoorRightsRequest);
  });
}

export function removeDoorRequest(doorId: string, pub: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => { requestsMap!.delete(reqKey(doorId, pub)); });
}

/** All pending requests, optionally for one door (sanitized, newest first). */
export function readDoorRequests(doorId?: string): DoorRightsRequest[] {
  if (!docAlive()) return [];
  const out: DoorRightsRequest[] = [];
  for (const v of requestsMap!.values()) {
    if (isRequest(v) && (!doorId || v.doorId === doorId)) out.push(v);
  }
  return out.sort((a, b) => b.at - a.at);
}

export function hasDoorRequest(doorId: string, pub: string): boolean {
  return docAlive() ? isRequest(requestsMap!.get(reqKey(doorId, pub))) : false;
}

// ── Grants ───────────────────────────────────────────────────────────────────

function isGrant(v: unknown): v is DoorRightsGrant {
  const g = v as Partial<DoorRightsGrant> | null;
  return !!g && typeof g.doorId === 'string' && typeof g.pub === 'string' && !!g.pub
    && typeof g.name === 'string' && typeof g.grantedAt === 'number';
}

/** The value stored under `reqKey(doorId, pub)` grants that door to that
 *  captain only when the record names both itself: the owner's list
 *  (readDoorGrants) reads the door and the captain's key from the record, so
 *  a record naming others admits nobody here. */
function isGrantFor(v: unknown, doorId: string, pub: string): v is DoorRightsGrant {
  return isGrant(v) && v.doorId === doorId && v.pub === pub;
}

/** Owner ACCEPT: standing, revocable grant; clears the matching request. */
export function writeDoorGrant(doorId: string, pub: string, name: string): void {
  if (!docAlive() || !pub) return;
  boundDoc!.transact(() => {
    grantsMap!.set(reqKey(doorId, pub), {
      doorId, pub, name: name || 'Unknown-Clone', grantedAt: Date.now(),
    } satisfies DoorRightsGrant);
    requestsMap!.delete(reqKey(doorId, pub));
  });
}

/** Owner REVOKE (or DENY doubles as remove-request via removeDoorRequest). */
export function removeDoorGrant(doorId: string, pub: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => { grantsMap!.delete(reqKey(doorId, pub)); });
}

export function readDoorGrants(doorId?: string): DoorRightsGrant[] {
  if (!docAlive()) return [];
  const out: DoorRightsGrant[] = [];
  for (const v of grantsMap!.values()) {
    if (isGrant(v) && (!doorId || v.doorId === doorId)) out.push(v);
  }
  return out.sort((a, b) => b.grantedAt - a.grantedAt);
}

export function hasDoorGrant(doorId: string, pub: string): boolean {
  return docAlive() ? isGrantFor(grantsMap!.get(reqKey(doorId, pub)), doorId, pub) : false;
}
