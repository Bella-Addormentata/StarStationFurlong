/**
 * The local node's `/api/fingerprint` answer, checked against the node's own
 * contract before anything is built on it — the WebTransport certificate
 * hash, the reachability row, and (tvConsent.ts) the trust that media from
 * the node's HTTP origin is this machine serving this viewer.
 *
 * The contract (ssf-p2p-node `compute_fingerprint`): `hex` is the SHA-256
 * of the node's certificate, 64 hex digits; `base64` is the SAME 32 bytes
 * in standard base64 (44 characters, one `=`); `port` is the WebTransport
 * port, a u16. The rest is optional (the Tauri fallback listener omits the
 * iroh fields) and is normalised, never required.
 *
 * Why it is checked at all: the node's port is a loopback port like any
 * other, and the page probes 8080 then 8081. A stranger on 8080 answering
 * `{}` must not end the probe before the node on 8081 is tried, and one
 * answering `{ hex: true }` must not pass as the node and have its origin
 * trusted. A matching shape says the answer is a fingerprint, not that the
 * answerer is honest — a service impersonating the node deliberately is
 * out of this check's reach, as it is out of any check's that the page can
 * make from here.
 */

import { isAddressOn, parseChiaNetwork, TESTNET11, type ChiaNetwork } from './chiaNetwork';

export interface LocalFingerprint {
  hex: string;
  base64: string;
  port: number;
  iroh_node_id?: string;
  iroh_relay_urls?: string[];
  iroh_direct_addrs?: string[];
  /** R1: live reachability classification from the node —
   *  'port-mapped' | 'advertised' | 'cgnat' | 'local-only'.
   *  Optional: the Tauri fallback listener's fingerprint omits it. */
  reachability?: string;
  /** R1: the iroh UDP port ACTUALLY bound (post random-port fallback) —
   *  the port a router forward must target. */
  iroh_port?: number;
  /** #231 P6b: whether the node hands out its contact card at all (a durable
   *  contact key and `SSF_CHIA_SHARE_CARD` not `0`). Absent from older nodes,
   *  which `nodeSharesCard` (roomCap.ts) reads as sharing. */
  share_card?: boolean;
  /** ⛓️ The Chia network the node runs on, always resolved: the page's own
   *  row (chiaNetwork.ts) when the node's `chia_network` id and genesis both
   *  match one, testnet11 when the node sends none (every node before stage
   *  2), and `null` when it names a network this page does not know. Then
   *  the page shows no address and says why. */
  chia_net: ChiaNetwork | null;
  /** ⛓️🏦 The node's receive address (`txch1…` on testnet11) while it has a
   *  wallet loaded (the publish build with the SSF wallet on): where coins
   *  are sent to fund the node's chain writes. Shown by the Bank app with
   *  COPY and a QR code; absent from read-only nodes and older ones. Kept
   *  only when it has the shape of an address on `chia_net` (`isAddressOn`),
   *  so never on an unknown network. */
  chia_address?: string;
  /** 📖 How the node's Phone Book listing stands (its per-node presence
   *  record on Chia, #231 P6a), for the top bar's icon (phoneBook.ts): green
   *  when the current addresses are listed, grey when an older listing has
   *  gone stale. Present only while the node publishes presence (the publish
   *  build with a wallet, a durable contact key and `SSF_CHIA_FINDABLE` not
   *  `0`) and has ticked once; kept only in the node's shape
   *  (`parseChiaPresence`). */
  chia_presence?: ChiaPresence;
  /** 🏦 The SSF wallet switch (the node's chia_wallet_switch.rs): whether
   *  this build can hold a wallet, whether `SSF_CHIA_LANE` in the node's
   *  environment holds it off, and whether it is on, for the Bank's TURN ON
   *  (bankWallet.ts); and whether its 24 words are backed up, for the Bank's
   *  BACK UP (bankBackup.ts). Absent from older nodes, which only
   *  `SSF_CHIA_LANE=1` turns on. Kept only in the node's shape
   *  (`parseChiaWallet`). */
  chia_wallet?: ChiaWalletSwitch;
  /** ⛓️ Whether Chia is off on this computer (the node's chia_strict.rs
   *  `LaneView`): off now or not, why (`SSF_NO_CHIA_LANE` in the node's
   *  environment, or the Chia switch in the SpacePhone's Network settings),
   *  and what that switch says for the node's next start (chiaLane.ts).
   *  Absent from nodes older than the strict lane; a node with the lane but
   *  not the switch sends no `setting`. Kept only in the node's shape
   *  (`parseChiaLane`). */
  chia_lane?: ChiaLane;
  /** 📖 LIST ME, the player's switch for this station's Phone Book writes
   *  on the node's network (the node's chia_listing.rs `ListingView`):
   *  whether the node may write its listing and its knocks there, whether
   *  the player turned the switch or its default stands, and whether
   *  `SSF_CHIA_FINDABLE=0` holds the listing off all the same (listMe.ts).
   *  Sent by every node that has the switch (`POST /api/chia/listing`);
   *  absent from older nodes and from builds that only read the chain. Kept
   *  only in the node's shape (`parseChiaListing`). */
  chia_listing?: ChiaListing;
  /** 📦 This launch's blob-lane token (64 hex): what the node's `/blob` and
   *  `/api/blob/` routes ask for beside an allowed Origin (blobLane.ts).
   *  Absent while the node runs without the lane, and from older nodes. */
  blob_cap?: string;
  /** 🧲 The node was built with the `torrent` feature and its blob lane is
   *  running: the TV's TORRENT tile can hand it a magnet (torrentLane.ts). */
  torrent?: boolean;
  /** 🏠 The node's house key (base64url, 43 characters): the key it signs
   *  its seeds for computed tables with (ssf-p2p-node house.rs). The room's
   *  deed holder delegates it (computedTable houseDuty). Absent from older
   *  nodes. Kept only in that shape. */
  house?: string;
  /** 🧮 What the node's fold of the casino tables serves (the node's
   *  `house_fold`, a `HouseFoldReport` in ssf-p2p-node main.rs), as far as a
   *  page reads it: whether the owner's node can run FAIR ONLY tables
   *  (computedTable setLocalHouseFold). Absent from a node built without the
   *  fold, with its house off, or older. Kept only in the node's shape
   *  (`parseHouseFold`). */
  house_fold?: HouseFold;
}

/** 🧮 The node's fold, as a page reads its report: the incarnation letters it
 *  folds (`rd` from the nodes that shadow house tables; a node that runs FAIR
 *  ONLY games adds `p` and `q`), the rules versions it serves at those two
 *  (`rv`: none from a node that serves neither), and whether the fold is off
 *  (`off`, sent with a reason: turned off in the node's environment, or its
 *  worker failed too often). The report's counters are the node's own. */
export interface HouseFold {
  letters: string;
  rv: string[];
  off?: true;
}

/** The node's `house_fold` in that shape, or undefined for anything else: no
 *  object, `letters` not a string of up to 26 lower-case letters, an `rv` that
 *  is there and is not a list of up to 16 rules versions as a game's name spells
 *  one (a lower-case letter, then up to seven letters or digits). A report this
 *  page cannot read is no report, and the page then offers nothing that needs
 *  one. An `off` of any kind reads as off: whatever the reason, the fold runs
 *  nothing now. Nothing else is copied. */
export function parseHouseFold(v: unknown): HouseFold | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.letters !== 'string' || !/^[a-z]{0,26}$/.test(r.letters)) return undefined;
  let rv: string[] = [];
  if (r.rv !== undefined) {
    if (!Array.isArray(r.rv) || r.rv.length > 16 || !r.rv.every((x) => typeof x === 'string' && /^[a-z][a-z0-9]{0,7}$/.test(x))) return undefined;
    rv = [...(r.rv as string[])];
  }
  const fold: HouseFold = { letters: r.letters, rv };
  if (r.off !== undefined && r.off !== null) fold.off = true;
  return fold;
}

/** 📖 The four looks of the phone book: this edition's listing confirmed
 *  with the current addresses (`listed`; last edition's
 *  too, while this edition's waits for its slot), out but not yet read back
 *  (`sent`), a listing of ours that is stale (`outdated`: an older edition,
 *  other addresses, no chain peak to judge by), none of ours (`unlisted`). */
export type ChiaPresenceState = 'listed' | 'sent' | 'outdated' | 'unlisted';

/** The node's readout (`ChiaPresence` in ssf-p2p-node main.rs): `era` is the
 *  current edition by the agreed peak (0 while none is agreed), `listed_era`
 *  and `last_at` describe the listing on record (0 when there is none),
 *  `confirmed` says the chain showed it back, `current` that it is the
 *  listing in force with these addresses, `public_addrs` how many the node
 *  would list now, and `error` is the last failed attempt's text, or the
 *  node's words for what the listing waits for, when there is one. A `listed`
 *  listing names this edition, or (stage 4 design §4.3)
 *  the edition before, while this edition's waits for its slot or its late
 *  start: `listed_era` is then `era - 1`, and readers still find it.
 *  `unlanded`, sent only when true, says an `outdated` listing of this
 *  edition with these addresses did not make it into the book, and the hint
 *  rule (§8.3) holds the next write until the next edition. */
export interface ChiaPresence {
  state: ChiaPresenceState;
  era: number;
  listed_era: number;
  last_at: number;
  confirmed: boolean;
  current: boolean;
  public_addrs: number;
  error?: string;
  unlanded?: boolean;
}

/** 🏦 The SSF wallet switch's state: `unbuilt` (a node built without
 *  publishing), `off` (`SSF_CHIA_LANE` holds it off), `ready` (the Bank may
 *  turn it on), `on` (the wallet is loaded). The same four on every network:
 *  mainnet makes SSF wallets now. An older mainnet node's `gated` (it made
 *  none there) is not one of them, so it reads as an older node. */
export type ChiaWalletState = 'unbuilt' | 'off' | 'ready' | 'on';

/** 🔒 How the wallet's file keeps its key on disk: `none` in the clear
 *  (owner-only on Unix), `dpapi` locked to this Windows account, `keychain`
 *  locked with a key in this Mac user's login keychain. */
export type ChiaWalletAtRest = 'none' | 'dpapi' | 'keychain';

/** 🖥️ Who can show the wallet's 24 words: `native` the desktop app, in a
 *  window of its own (its channel to the node is on), `page` this page (a
 *  test network, no channel), `none` nobody here (any other network with no
 *  channel). A hint for which BACK UP to offer (bankBackup.ts); the node and
 *  the app still decide. */
export type ChiaWalletBackup = 'native' | 'page' | 'none';

export interface ChiaWalletSwitch {
  state: ChiaWalletState;
  /** Ready: the 24-word identity from an earlier run (`chia_identity.json`)
   *  is on disk, so turning on brings back that wallet and its address. */
  seed?: boolean;
  /** Ready, with no 24-word identity: only a raw-seed wallet from before the
   *  24 words is on disk. Turning on retires it and makes a new wallet, at a
   *  new address (bankWallet.ts words CREATE so). */
  legacy?: boolean;
  /** On: back on at the node's next start. */
  stays?: boolean;
  /** On: `SSF_CHIA_LANE=1` holds it on; the Bank cannot turn it off. */
  held?: boolean;
  /** On: the loaded wallet is made from 24 words the node keeps. Ready:
   *  turning on makes or loads a wallet from 24 words. The capability marker
   *  for the Bank's BACK UP (bankBackup.ts) and CREATE's wording
   *  (bankWallet.ts): older nodes never send it, and the Bank offers BACK UP
   *  only when it is present. */
  mnemonic?: boolean;
  /** On, with `mnemonic`: the player marked this key's 24 words saved, so
   *  the Bank does not show them again. */
  backed_up?: boolean;
  /** On: this run's load retired a raw-seed wallet and made a new one. */
  reminted?: boolean;
  /** On, with `mnemonic`: how the wallet's file keeps its key on disk. An
   *  older node never sends it. */
  at_rest?: ChiaWalletAtRest;
  /** On, with the file in the clear: the lock it gets once its words are
   *  saved. Absent where there is no lock to come (no store on this
   *  computer, or `SSF_WALLET_AT_REST=none`). */
  at_rest_next?: ChiaWalletAtRest;
  /** On: this run locked the file, so folder copies made before still hold
   *  the key in the clear. */
  rewrapped?: boolean;
  /** Why the last turn failed, in the node's words. */
  error?: string;
  /** 🖥️ In every state: who can show the 24 words. An older node never
   *  sends it, and a value this page does not know is dropped: both read as
   *  absent, which BACK UP treats exactly as before the field (the page
   *  reveal on a test network, none elsewhere). */
  backup?: ChiaWalletBackup;
}

/** The switch's flags, every one a boolean the node sends only when true.
 *  Nothing else is copied: the fingerprint never carries the words, and a
 *  field of any other name from a node (or a stranger on its port) is
 *  dropped here. */
const WALLET_FLAGS = ['seed', 'legacy', 'stays', 'held', 'mnemonic', 'backed_up', 'reminted', 'rewrapped'] as const;

/** The at-rest fields: a string, kept only when it is a lock this page can
 *  word (a newer node's other lock is dropped, not the whole switch). */
const WALLET_AT_REST = ['at_rest', 'at_rest_next'] as const;
const AT_REST_KINDS: ReadonlySet<string> = new Set<ChiaWalletAtRest>(['none', 'dpapi', 'keychain']);

const BACKUP_KINDS: ReadonlySet<string> = new Set<ChiaWalletBackup>(['native', 'page', 'none']);

const WALLET_STATES: ReadonlySet<string> = new Set<ChiaWalletState>(['unbuilt', 'off', 'ready', 'on']);

/** The node's `chia_wallet` in its own shape, or undefined for anything
 *  else: an unknown state, a flag that is not a boolean, or an error that is
 *  not a string. The Bank then words the node as an older one, which offers
 *  no switch rather than one the node might not have. */
export function parseChiaWallet(v: unknown): ChiaWalletSwitch | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.state !== 'string' || !WALLET_STATES.has(r.state)) return undefined;
  for (const flag of WALLET_FLAGS) {
    if (r[flag] !== undefined && typeof r[flag] !== 'boolean') return undefined;
  }
  for (const field of WALLET_AT_REST) {
    if (r[field] !== undefined && typeof r[field] !== 'string') return undefined;
  }
  if (r.error !== undefined && typeof r.error !== 'string') return undefined;
  const w: ChiaWalletSwitch = { state: r.state as ChiaWalletState };
  for (const flag of WALLET_FLAGS) {
    if (r[flag] === true) w[flag] = true;
  }
  for (const field of WALLET_AT_REST) {
    const kind = r[field];
    if (typeof kind === 'string' && AT_REST_KINDS.has(kind)) w[field] = kind as ChiaWalletAtRest;
  }
  if (typeof r.error === 'string' && r.error) w.error = r.error;
  // Only the three words, exactly: anything else (another word, another
  // case, not a string) is dropped, never the switch, so a newer node's
  // value leaves the Bank as it was before the field.
  if (typeof r.backup === 'string' && BACKUP_KINDS.has(r.backup)) w.backup = r.backup as ChiaWalletBackup;
  return w;
}

/** ⛓️ What holds Chia off: `env` for `SSF_NO_CHIA_LANE` in the node's
 *  environment (it wins when both do), `setting` for the Chia switch in the
 *  SpacePhone's Network settings (its file said off, or could not be read,
 *  at the node's start, or it was turned off in this run). */
export type ChiaLaneSource = 'env' | 'setting';

/** ⛓️ What the Chia switch's file says now, which the node's next start
 *  reads: `off` while the file says off or cannot be read. */
export type ChiaLaneSetting = 'on' | 'off';

export interface ChiaLane {
  /** Chia is off on this computer now: no chain reads, no chain writes. */
  off: boolean;
  /** Only while off: what holds it off. */
  source?: ChiaLaneSource;
  /** What the switch says for the next start. Sent by every node that has
   *  the switch (`POST /api/chia/lane`), so it marks the switch the way
   *  `mnemonic` marks BACK UP: a node with the lane but not the switch never
   *  sends it. Off now with the source `setting` and this `on` is "off until
   *  the node restarts". The node cannot know whether `SSF_NO_CHIA_LANE` is
   *  set at its next start, so this says only what the switch says. */
  setting?: ChiaLaneSetting;
  /** The switch's file is there but cannot be read, so it counts as off. */
  damaged?: true;
  /** With `damaged`: a folder stands where the switch's file goes, which
   *  the node cannot remove, so turning the switch back on here cannot work:
   *  only removing the folder by hand brings Chia back. */
  stuck?: true;
}

const LANE_SOURCES: ReadonlySet<string> = new Set<ChiaLaneSource>(['env', 'setting']);
const LANE_SETTINGS: ReadonlySet<string> = new Set<ChiaLaneSetting>(['on', 'off']);

/** The node's `chia_lane` in its own shape, or undefined when `off` is not
 *  a boolean (or it is not an object at all). A source is kept only while
 *  off and only as a word this page knows; `setting` only as `on` or `off`;
 *  `damaged` and `stuck` only as true. An unknown word is dropped, never
 *  `off`: a page that cannot say why still says Chia is off. Nothing else is
 *  copied. */
export function parseChiaLane(v: unknown): ChiaLane | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.off !== 'boolean') return undefined;
  const lane: ChiaLane = { off: r.off };
  if (r.off && typeof r.source === 'string' && LANE_SOURCES.has(r.source)) lane.source = r.source as ChiaLaneSource;
  if (typeof r.setting === 'string' && LANE_SETTINGS.has(r.setting)) lane.setting = r.setting as ChiaLaneSetting;
  if (r.damaged === true) lane.damaged = true;
  if (r.stuck === true) lane.stuck = true;
  return lane;
}

/** 📖 What the node's LIST ME switch says for its network (the node's
 *  chia_listing.rs). It says what the switch says, never whether anything
 *  was written: the listing's own readout is `chia_presence`. */
export interface ChiaListing {
  /** LIST ME is on: by the player's word, or by the network's default (on
   *  for a test network, off where the coins are real money). */
  on: boolean;
  /** The player turned the switch on this network (`false`: its default
   *  stands, or its file cannot be read). */
  chosen: boolean;
  /** `SSF_CHIA_FINDABLE=0` in the node's environment holds the listing off
   *  whatever `on` says; the knocks follow `on`. */
  held?: true;
  /** The switch's file is there but cannot be read, so it counts as off. */
  damaged?: true;
  /** The node writes what the switch allows from keys of their own that the
   *  lobby dish pays for, so its SSF wallet pays for no listing and no knock
   *  and a coin in it lists nothing. A node says so on every network since
   *  stage 4 PR 12. One from before this field never says it, and one from
   *  just before that PR could be started not to: on a test network the
   *  wallet of such a node may be the payer. Off a test network the lobby
   *  dish pays whether the node says so or not. */
  dish?: true;
}

/** The node's `chia_listing` in its own shape, or undefined when `on` or
 *  `chosen` is not a boolean (or it is not an object at all): a switch this
 *  page cannot read is no switch, and the page then offers none. `held`,
 *  `damaged` and `dish` are kept only as true. A switch that cannot be read never
 *  reads as on here, whatever else the answer says. Nothing else is
 *  copied. */
export function parseChiaListing(v: unknown): ChiaListing | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.on !== 'boolean' || typeof r.chosen !== 'boolean') return undefined;
  const damaged = r.damaged === true;
  const listing: ChiaListing = { on: r.on && !damaged, chosen: r.chosen };
  if (r.held === true) listing.held = true;
  if (damaged) listing.damaged = true;
  if (r.dish === true) listing.dish = true;
  return listing;
}

const PRESENCE_STATES: ReadonlySet<string> = new Set<ChiaPresenceState>(['listed', 'sent', 'outdated', 'unlisted']);

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The node's `chia_presence` in its own shape, or undefined for anything
 *  else: an unknown state, a count that is not a non-negative integer, a flag
 *  that is not a boolean, or an error that is not a string. A readout the
 *  page cannot trust is no readout: the icon stays hidden rather than guess.
 *  `unlanded` is kept only when true, as the node sends it. */
export function parseChiaPresence(v: unknown): ChiaPresence | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.state !== 'string' || !PRESENCE_STATES.has(r.state)) return undefined;
  if (!isCount(r.era) || !isCount(r.listed_era) || !isCount(r.last_at) || !isCount(r.public_addrs)) return undefined;
  if (typeof r.confirmed !== 'boolean' || typeof r.current !== 'boolean') return undefined;
  if (r.error !== undefined && typeof r.error !== 'string') return undefined;
  if (r.unlanded !== undefined && typeof r.unlanded !== 'boolean') return undefined;
  const p: ChiaPresence = {
    state: r.state as ChiaPresenceState,
    era: r.era,
    listed_era: r.listed_era,
    last_at: r.last_at,
    confirmed: r.confirmed,
    current: r.current,
    public_addrs: r.public_addrs,
  };
  if (typeof r.error === 'string') p.error = r.error;
  if (r.unlanded === true) p.unlanded = true;
  return p;
}

const HEX_32 = /^[0-9a-f]{64}$/i;
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

function isPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65535;
}

/** The 32 bytes `base64` carries, or null when it is not 32 bytes of base64. */
function decode32(b64: string): Uint8Array | null {
  if (!BASE64_32.test(b64)) return null;
  try {
    const bin = atob(b64);
    if (bin.length !== 32) return null;
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The answer as a fingerprint, or null when it is not one: not an object,
 *  a `hex` that is not 32 bytes of hex, a `base64` that is not the same 32
 *  bytes, or a `port` that is not a port. */
export function parseNodeFingerprint(body: unknown): LocalFingerprint | null {
  if (!body || typeof body !== 'object') return null;
  const r = body as Record<string, unknown>;
  if (typeof r.hex !== 'string' || !HEX_32.test(r.hex)) return null;
  if (typeof r.base64 !== 'string') return null;
  const bytes = decode32(r.base64);
  if (!bytes) return null;
  const hex = r.hex.toLowerCase();
  for (let i = 0; i < 32; i++) {
    if (bytes[i] !== parseInt(hex.slice(i * 2, i * 2 + 2), 16)) return null;
  }
  if (!isPort(r.port)) return null;
  // An absent `chia_network` is testnet11; one this page does not know is null.
  const net = parseChiaNetwork(r.chia_network);
  const fp: LocalFingerprint = { hex, base64: r.base64, port: r.port, chia_net: net === undefined ? TESTNET11 : net };
  if (typeof r.iroh_node_id === 'string') fp.iroh_node_id = r.iroh_node_id;
  const relays = stringArray(r.iroh_relay_urls);
  if (relays) fp.iroh_relay_urls = relays;
  const addrs = stringArray(r.iroh_direct_addrs);
  if (addrs) fp.iroh_direct_addrs = addrs;
  if (typeof r.reachability === 'string') fp.reachability = r.reachability;
  if (typeof r.iroh_port === 'number' && Number.isInteger(r.iroh_port) && r.iroh_port >= 0 && r.iroh_port <= 65535) {
    fp.iroh_port = r.iroh_port;
  }
  if (typeof r.share_card === 'boolean') fp.share_card = r.share_card;
  if (isAddressOn(fp.chia_net, r.chia_address)) fp.chia_address = r.chia_address;
  const presence = parseChiaPresence(r.chia_presence);
  if (presence) fp.chia_presence = presence;
  const wallet = parseChiaWallet(r.chia_wallet);
  if (wallet) fp.chia_wallet = wallet;
  const lane = parseChiaLane(r.chia_lane);
  if (lane) fp.chia_lane = lane;
  const listing = parseChiaListing(r.chia_listing);
  if (listing) fp.chia_listing = listing;
  if (typeof r.blob_cap === 'string' && /^[0-9a-f]{64}$/.test(r.blob_cap)) fp.blob_cap = r.blob_cap;
  if (r.torrent === true) fp.torrent = true;
  if (typeof r.house === 'string' && /^[A-Za-z0-9_-]{43}$/.test(r.house)) fp.house = r.house;
  const fold = parseHouseFold(r.house_fold);
  if (fold) fp.house_fold = fold;
  return fp;
}
