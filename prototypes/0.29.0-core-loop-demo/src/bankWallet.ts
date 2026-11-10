// 🏦 The SSF wallet switch in the SpacePhone's Bank (#335 stage 1).
//
// The node holds a Chia wallet only while its SSF wallet is on. Until this
// switch that took `SSF_CHIA_LANE=1` in the node's environment, which a player
// of the desktop app never sees; now the Bank's CREATE SSF WALLET (TURN ON
// when the 24-word identity from before is on disk) asks the node to turn it
// on, and the node remembers it for its next start. A node that kept only a
// raw-seed wallet from before the 24 words offers CREATE too: turning on
// retires that wallet and makes a new one at a new address, and says so. This
// module decides what the Bank's RECEIVE section says and offers, from the
// node's fingerprint and the page's own state, and sends the request, so both
// are tested without main.ts. The 24 words' BACK UP is bankBackup.ts.
//
// The node words its own refusals (a build that only reads, `SSF_CHIA_LANE`
// holding the wallet off or on); the page only says what it saw itself (no
// answer, a timeout, an older node).
//
// ⛓️ The texts follow the node's Chia network (chiaNetwork.ts): a network
// line above the switch, amber on mainnet, and no address at all on a
// network this page does not know. On mainnet the node makes a new SSF
// wallet only when the desktop app started it (its `backup` is `native`),
// so the app can show the 24 words; with any other `backup` the Bank offers
// no CREATE there, and TURN ON of a wallet already on disk works as on
// testnet11.
//
// ⛓️ While Chia is off on this computer (chiaLane.ts: `SSF_NO_CHIA_LANE` in
// the node's environment, or the Chia switch in the SpacePhone's Network
// settings), RECEIVE says so and why, above every wallet state: no switch,
// no address, no balance. A wallet loaded before an in-run off stays loaded
// until the node stops, but writes nothing to the chain.
//
// 📖 What the wallet has to do with the Phone Book follows the network and
// the player's LIST ME (listMe.ts, stage 4 PR 11). On a test network the
// wallet pays for the listing, while LIST ME is on. On a network whose coins
// are real money it pays for no chain write: the listing and the knocks are
// written from keys of their own that the lobby dish pays for, only while
// LIST ME is on, so the wallet's address is never in the book, and RECEIVE
// says so (`listing`).

import { chiaBackOn, chiaOffWhy } from './chiaLane';
import type { ChiaNetwork } from './chiaNetwork';
import type { ChiaLane, ChiaListing, ChiaWalletSwitch, LocalFingerprint } from './nodeFingerprint';

/** The page's own part: CREATE armed and waiting for CONFIRM, a request in
 *  flight, and the last request's failure in the page's or the node's words. */
export interface BankWalletUi {
  armed: boolean;
  turning: boolean;
  error: string | null;
}

/** What the switch button does when tapped. */
export type BankWalletAct = 'arm' | 'confirm' | 'off' | 'keep';

export interface BankWalletView {
  /** ⛓️ The network line, above everything else: which Chia network the
   *  node runs on and what its coins are. `warn` draws it amber (mainnet:
   *  real money). None without a node, or on a network the page does not
   *  know (`text` says so instead). */
  network: { text: string; warn: boolean } | null;
  /** 📖 Under the network line, off a test network, while the node has an
   *  SSF wallet to turn on or holds one: who pays for the Phone Book
   *  listing there (`BANK_LISTING_LINE`). None on a test network, where
   *  the wallet may be the payer, or from a node older than LIST ME. */
  listing: string | null;
  /** The line above the address, or instead of it. */
  text: string;
  /** A warning under it: what turning on means, before CONFIRM. */
  warning: string | null;
  /** A line above the address while it applies: the node replaced its old
   *  raw-seed wallet in this run, so the address is new and unlisted. */
  notice: string | null;
  /** Why the last turn failed. */
  error: string | null;
  /** The switch, or none: one control with a stable id whatever it says, so
   *  focus stays on it from CREATE to CONFIRM to TURNING ON. `busy` marks it
   *  inert while a request is in flight (it keeps focus, unlike `disabled`). */
  button: { act: BankWalletAct; label: string; danger: boolean; busy: boolean } | null;
  /** Whether the address, its QR code and the balance show. */
  showsAddress: boolean;
}

/** The switch's id in the Bank's markup. */
export const BANK_WALLET_BUTTON_ID = 'bank-wallet-switch';

/** How long the page waits for the node's answer. Turning on mints a key,
 *  restores the wallet's lease under the same gate the chain reads hold, and
 *  saves the switch, which is quick unless a chain read holds the gate. */
export const TURN_TIMEOUT_MS = 45_000;

/** 📖 The Bank's line off a test network (stage 4 design §4.5 (6)): the
 *  SSF wallet pays for no Phone Book write there, so its address is never
 *  on the chain beside one. */
export const BANK_LISTING_LINE = "Your Phone Book listing is paid by the lobby dish, never by this wallet. This wallet's address is never in the book.";

/** Where the player finds LIST ME. */
const LIST_ME_WHERE = '⚙️ SETTINGS → 🌐 NETWORK';

/** 📖 What a wallet turned on means for the Phone Book, in the warnings
 *  before CONFIRM. `listing` is the node's LIST ME: none from a node older
 *  than it, which listed itself on a test network whenever its wallet held
 *  a coin and wrote nothing off one. `wallet` names the wallet in the
 *  sentence; `dish` adds what the faucet dish gives, on a test network
 *  only (no lobby jar is promised real coins here).
 *
 *  Off a test network it promises no listing from the wallet: there the
 *  lobby dish pays, and only while LIST ME is on. On a test network with
 *  LIST ME off it promises none either. */
export function listsWhen(net: ChiaNetwork, listing: ChiaListing | undefined, wallet = 'the wallet', dish = false): string {
  if (!net.test) {
    return listing
      ? `On ${net.name} ${wallet} pays for no Phone Book write, and its address is never in the book: your station is listed there only while LIST ME is on (${LIST_ME_WHERE}), paid by the lobby dish.`
      : `On ${net.name} ${wallet} pays for no Phone Book write.`;
  }
  if (listing && !listing.on) {
    return `LIST ME is off for ${net.name} (${LIST_ME_WHERE}), so your node writes no Phone Book listing there until you turn it on.`;
  }
  return `Once ${wallet} holds a coin${dish ? ' (one mojo from the faucet dish is enough)' : ''} it lists itself in the Phone Book on ${net.chain}.`;
}

const TURN_ON_WARNING = (net: ChiaNetwork, listing: ChiaListing | undefined): string =>
  `Turn the SSF wallet back on? Your node loads the wallet it kept from before, with the same address. ${listsWhen(net, listing)} Tap CONFIRM.`;
const CREATE_WARNING = (net: ChiaNetwork, listing: ChiaListing | undefined): string =>
  `Create an SSF wallet? Your node makes a new ${net.name} key from 24 words, keeps them in its folder on this computer, and shows you the words to write down. ${listsWhen(net, listing, 'the wallet', true)} Tap CONFIRM.`;
/** CREATE on a node older than the 24 words (#352's), which never says
 *  `mnemonic`: its wallet is a raw key, which the next update replaces. */
const CREATE_OLDER_NODE_WARNING = (net: ChiaNetwork, _listing: ChiaListing | undefined): string =>
  `Your station node is older than the Bank's 24-word backup: it makes a ${net.name} key you cannot write down, and updating Star Station later replaces that wallet with a new one at a new address. Update Star Station first, or tap CONFIRM to create it anyway.`;
const CREATE_LEGACY_WARNING = (net: ChiaNetwork, listing: ChiaListing | undefined): string =>
  `Create a new SSF wallet? Your node's wallet from before was not made from 24 words, so no other Chia wallet can open it. Your node retires it (its file stays in your node's folder, and its ${net.coins} stay at its old address), makes a new ${net.name} key from 24 words at a new address, and shows you the words to write down. ${listsWhen(net, listing, 'the new wallet')} Tap CONFIRM.`;
/** The notice over a replaced wallet's new address. Only where the wallet
 *  pays for the listing does an empty one hold the listing back: on a test
 *  network, with LIST ME on. */
const REMINTED = (net: ChiaNetwork, listing: ChiaListing | undefined): string => {
  const replaced = `Your node replaced its old SSF wallet with a new one made from 24 words, at a new address. The old wallet's ${net.coins} stay at its old address.`;
  return net.test && (!listing || listing.on) ? `${replaced} Until the new one holds a coin, your node is not listed in the Phone Book.` : replaced;
};

/** ⛓️ The network line: what the node's coins are. */
export function networkLine(net: ChiaNetwork): { text: string; warn: boolean } {
  return net.test
    ? { text: `Network: ${net.name}. Its coins (${net.ticker}) are free test coins.`, warn: false }
    : { text: `Network: ${net.name}. Its coins (${net.ticker}) are real money.`, warn: true };
}

/** Whether nothing on this page can bring an SSF wallet on: off a test
 *  network, with no desktop app channel to the node (`backup` is not
 *  `native`) and no wallet on disk (`seed`), the node refuses to make a new
 *  wallet whose words nothing here can show. The Bank then offers no CREATE
 *  and the Phone Book's row names the desktop app, not the Bank. */
export function mintsOnlyInApp(net: ChiaNetwork, w: ChiaWalletSwitch): boolean {
  return !net.test && !w.seed && w.backup !== 'native';
}

/** Off a test network, with no desktop app channel to the node (`backup`
 *  is not `native`): the node refuses to make a new wallet whose words
 *  nothing here can show, so the Bank offers no CREATE. */
export const createInAppText = (net: ChiaNetwork): string =>
  `On ${net.name} your station node makes a new SSF wallet only when the Star Station desktop app started it, so the app can show its 24 words.`;
/** A node with no switch this page reads, off a test network: one older
 *  than mainnet's SSF wallet (it sent `gated`), or one this page cannot
 *  read. */
export const olderNodeText = (net: ChiaNetwork): string =>
  `Your station node is older than this page and makes no SSF wallet on ${net.name}: update Star Station.`;
/** The node names a network this page does not know. */
export const UNKNOWN_NETWORK_TEXT = 'Your node runs on a Chia network this page does not know, so the Bank shows no address.';

/** ⛓️ The note under RECEIVE's address, one per network: what to pay it
 *  with, and what one coin buys. `lead` is drawn bold. Off a test network
 *  a coin buys no chain write (the lobby dish pays for the listing and the
 *  knocks), so the note asks for none. */
export function receiveNote(net: ChiaNetwork): { lead: string; text: string } {
  return net.test
    ? {
      lead: `${net.name} only.`,
      text: `Scan the code or paste the address in a ${net.name} wallet (a testnet faucet gives ${net.ticker} for free). One coin pays this node's chain writes (presence, knocks, the dish) for good, since every write is a zero-fee spend to self. A mainnet wallet refuses a ${net.prefix} address, so real XCH cannot land here by mistake.`,
    }
    : {
      lead: `Real ${net.ticker}.`,
      text: `This address takes real ${net.ticker} on ${net.name}. Scan the code or paste the address in a Chia wallet set to mainnet. Your node pays for no chain write from it, so it needs no coin, and your node keeps its key on this computer: send only a little.`,
    };
}

/** THE REGISTRY's line on the Chia account, with the node's network: a
 *  mainnet wallet holds real money, so it is never called a test one. No
 *  network without a node, or on one this page does not know. ⛓️ While
 *  Chia is off on this computer (`lane`) RECEIVE turns no wallet on and
 *  shows no address or balance, so the line says why instead of sending
 *  the player there. */
export function registryChiaLine(net: ChiaNetwork | null | undefined, lane?: ChiaLane | null): string {
  const where = !net ? '' : net.test ? ` (${net.name}, a test network)` : ` (${net.name}: real ${net.ticker})`;
  if (lane?.off) {
    return `Chia account: your SSF wallet, kept by your station node on this computer${where}; ${chiaOffWhy(lane)}, so the Bank turns no wallet on and shows no address or balance under RECEIVE.`;
  }
  return `Chia account: your SSF wallet, kept by your station node on this computer${where}; turn it on, and see its address and balance, under RECEIVE.`;
}

/** ⛓️ RECEIVE's line while Chia is off: why, and what that leaves of the
 *  wallet. `loaded`: the node holds a wallet from before an in-run off.
 *  `kept`: it loads none, but keeps one from before on disk (the 24-word
 *  file, or a raw-seed one), which stays there. */
export function chiaOffBankText(lane: ChiaLane, loaded: boolean, kept = false): string {
  const why = chiaOffWhy(lane);
  const text = loaded
    ? `${why}: your node keeps its SSF wallet loaded until it stops, but writes nothing to the chain with it, so the Bank shows no address or balance.`
    : `${why}, so your node loads no SSF wallet and the Bank shows no address.${kept ? ' The SSF wallet it kept from before stays on this computer.' : ''}`;
  const back = chiaBackOn(lane);
  return back ? `${text} ${back}` : text;
}

/** What the Bank's RECEIVE section shows about the wallet. */
export function bankWalletView(fp: LocalFingerprint | null | undefined, ui: BankWalletUi): BankWalletView {
  if (!fp) {
    return { network: null, listing: null, warning: null, notice: null, button: null, text: 'Your station node is not answering, so there is no wallet to show.', error: null, showsAddress: false };
  }
  const w = fp.chia_wallet;
  const error = ui.error ?? w?.error ?? null;
  const net = fp.chia_net;
  // ⛓️ Chia off on this computer beats every wallet state: the node turns no
  // wallet on (it refuses), and one it still holds writes nothing.
  if (fp.chia_lane?.off) {
    const loaded = w?.state === 'on' || fp.chia_address !== undefined;
    const kept = w?.seed === true || w?.legacy === true;
    return { network: net ? networkLine(net) : null, listing: null, warning: null, notice: null, button: null, text: chiaOffBankText(fp.chia_lane, loaded, kept), error: ui.error ?? null, showsAddress: false };
  }
  // A network this page does not know: no address (the fingerprint parse
  // keeps none), no switch, and the reason.
  if (!net) return { network: null, listing: null, warning: null, notice: null, button: null, text: UNKNOWN_NETWORK_TEXT, error, showsAddress: false };
  const listMe = fp.chia_listing;
  // 📖 Who pays for the listing, off a test network: said wherever the
  // node holds a wallet or can turn one on, and has a LIST ME to speak of.
  const pays = !net.test && listMe && w && (w.state === 'on' || w.state === 'ready') ? BANK_LISTING_LINE : null;
  const bare = { network: networkLine(net), listing: null, warning: null, notice: null, button: null } as const;
  const none = { ...bare, listing: pays } as const;
  if (fp.chia_address) {
    if (!w) return { ...bare, text: '', error: null, showsAddress: true };
    const notice = w.state === 'on' && w.reminted ? REMINTED(net, listMe) : null;
    if (w.held) {
      return { ...none, notice, text: "SSF wallet on — SSF_CHIA_LANE=1 in your node's environment holds it on.", error, showsAddress: true };
    }
    if (w.stays) {
      return {
        network: none.network,
        listing: pays,
        warning: null,
        notice,
        text: 'SSF wallet on — it comes back on whenever your node starts.',
        error,
        button: { act: 'off', label: ui.turning ? 'TURNING OFF…' : 'TURN OFF', danger: false, busy: ui.turning },
        showsAddress: true,
      };
    }
    return {
      network: none.network,
      listing: pays,
      warning: null,
      notice,
      text: 'SSF wallet on until your node stops: it is turned off, so it does not come back at the next start.',
      error,
      button: { act: 'keep', label: ui.turning ? 'KEEPING ON…' : 'KEEP IT ON', danger: false, busy: ui.turning },
      showsAddress: true,
    };
  }
  if (!w) {
    return {
      ...bare,
      // Every node before the switch ran on testnet11 only.
      text: net.test
        ? 'Your station node has no wallet loaded, and it is older than the Bank\'s wallet switch: update Star Station, or start the node with SSF_CHIA_LANE=1.'
        : olderNodeText(net),
      error: null,
      showsAddress: false,
    };
  }
  switch (w.state) {
    case 'unbuilt':
      return { ...bare, text: 'This build of your station node only reads the chain, so it cannot hold a wallet. The Star Station installers ship a node that can.', error: null, showsAddress: false };
    case 'off':
      return { ...bare, text: "Your station node's SSF wallet is switched off by SSF_CHIA_LANE in its environment, so the Bank cannot turn it on.", error: null, showsAddress: false };
    case 'on':
      // On, but the address did not read as one of this network's: nothing to pay.
      return { ...none, text: `Your node's SSF wallet is on, but its address did not read as a ${net.name} address, so it is not shown.`, error, showsAddress: false };
    case 'ready': {
      const label = w.seed ? 'TURN ON SSF WALLET' : 'CREATE SSF WALLET';
      // A raw-seed wallet from before the 24 words is retired, not loaded:
      // that is a CREATE, with its own warning, never a TURN ON.
      const legacy = !w.seed && w.legacy === true;
      // Off a test network the node mints only for the desktop app that
      // started it, so a CREATE anywhere else would only be refused. A
      // wallet already on disk loads (TURN ON) either way.
      if (mintsOnlyInApp(net, w)) {
        return { ...bare, text: createInAppText(net), error, showsAddress: false };
      }
      if (ui.turning) {
        return { network: none.network, listing: pays, warning: null, notice: null, text: 'Turning your SSF wallet on…', error: null, button: { act: 'confirm', label: 'TURNING ON…', danger: false, busy: true }, showsAddress: false };
      }
      if (ui.armed) {
        return {
          network: none.network,
          listing: pays,
          text: 'Your station node has no SSF wallet on yet, so there is no address to pay.',
          // Only a node that says `mnemonic` makes its wallet from 24 words.
          warning: (w.seed ? TURN_ON_WARNING : legacy ? CREATE_LEGACY_WARNING : w.mnemonic === true ? CREATE_WARNING : CREATE_OLDER_NODE_WARNING)(net, listMe),
          notice: null,
          error,
          button: { act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false },
          showsAddress: false,
        };
      }
      return {
        network: none.network,
        listing: pays,
        warning: null,
        notice: null,
        text: w.seed
          ? 'Your station node has a wallet from before, but its SSF wallet is off, so there is no address to pay.'
          : legacy
            ? 'Your station node has a wallet from before the 24 words; turning the SSF wallet on replaces it with a new one, so there is no address to pay yet.'
            : 'Your station node has no SSF wallet yet, so there is no address to pay.',
        error,
        button: { act: 'arm', label, danger: false, busy: false },
        showsAddress: false,
      };
    }
  }
}

export type TurnResult = { ok: true } | { ok: false; error: string };

/** Ask the node at `origin` to turn its SSF wallet on or off. Never throws:
 *  a refusal comes back in the node's words, anything else in the page's. */
export async function turnSsfWallet(
  origin: string,
  on: boolean,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = TURN_TIMEOUT_MS,
): Promise<TurnResult> {
  if (!origin) return { ok: false, error: 'your station node is not answering' };
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // No redirect: the answer must be the node's own (the fingerprint probe's
    // rule). No body and no custom header: a simple request, no preflight.
    const res = await fetchImpl(`${origin}/api/chia/wallet?on=${on ? 1 : 0}`, { method: 'POST', signal: ctl.signal, redirect: 'error' });
    if (res.status === 404) {
      return { ok: false, error: "your station node is older than the Bank's wallet switch: update Star Station" };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (e) {
      // The deadline can land while the body is read: that is a timeout,
      // worded below, not an answer.
      if (ctl.signal.aborted) throw e;
      // not JSON: worded from the status below
    }
    const r = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    if (res.ok && r.ok === true) return { ok: true };
    const said = typeof r.error === 'string' && r.error.trim() ? r.error.trim().slice(0, 400) : '';
    return { ok: false, error: said || `your station node answered ${res.status}` };
  } catch {
    return {
      ok: false,
      error: ctl.signal.aborted
        ? 'your station node did not answer in time; it may still be turning the wallet, so look again in a moment'
        : 'your station node could not be reached',
    };
  } finally {
    clearTimeout(deadline);
  }
}
