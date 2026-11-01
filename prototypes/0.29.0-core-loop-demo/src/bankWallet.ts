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

import type { LocalFingerprint } from './nodeFingerprint';

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

const TURN_ON_WARNING =
  'Turn the SSF wallet back on? Your node loads the wallet it kept from before, with the same address, and once the wallet holds a coin it lists itself in the Phone Book on the test chain. Tap CONFIRM.';
const CREATE_WARNING =
  'Create an SSF wallet? Your node makes a new testnet11 key from 24 words, keeps them in its folder on this computer, and shows you the words to write down. Once the wallet holds a coin (one mojo from the faucet dish is enough) it lists itself in the Phone Book on the test chain. Tap CONFIRM.';
const CREATE_LEGACY_WARNING =
  "Create a new SSF wallet? Your node's wallet from before was not made from 24 words, so no other Chia wallet can open it. Your node retires it (its file stays in your node's folder, and its testnet coins stay at its old address), makes a new testnet11 key from 24 words at a new address, and shows you the words to write down. Once the new wallet holds a coin it lists itself in the Phone Book on the test chain. Tap CONFIRM.";
const REMINTED =
  "Your node replaced its old SSF wallet with a new one made from 24 words, at a new address. The old wallet's testnet coins stay at its old address. Until the new one holds a coin, your node is not listed in the Phone Book.";

/** What the Bank's RECEIVE section shows about the wallet. */
export function bankWalletView(fp: LocalFingerprint | null | undefined, ui: BankWalletUi): BankWalletView {
  const none = { warning: null, notice: null, button: null } as const;
  if (!fp) {
    return { ...none, text: 'Your station node is not answering, so there is no wallet to show.', error: null, showsAddress: false };
  }
  const w = fp.chia_wallet;
  const error = ui.error ?? w?.error ?? null;
  if (fp.chia_address) {
    if (!w) return { ...none, text: '', error: null, showsAddress: true };
    const notice = w.state === 'on' && w.reminted ? REMINTED : null;
    if (w.held) {
      return { ...none, notice, text: "SSF wallet on — SSF_CHIA_LANE=1 in your node's environment holds it on.", error, showsAddress: true };
    }
    if (w.stays) {
      return {
        warning: null,
        notice,
        text: 'SSF wallet on — it comes back on whenever your node starts.',
        error,
        button: { act: 'off', label: ui.turning ? 'TURNING OFF…' : 'TURN OFF', danger: false, busy: ui.turning },
        showsAddress: true,
      };
    }
    return {
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
      ...none,
      text: 'Your station node has no wallet loaded, and it is older than the Bank\'s wallet switch: update Star Station, or start the node with SSF_CHIA_LANE=1.',
      error: null,
      showsAddress: false,
    };
  }
  switch (w.state) {
    case 'unbuilt':
      return { ...none, text: 'This build of your station node only reads the chain, so it cannot hold a wallet. The Star Station installers ship a node that can.', error: null, showsAddress: false };
    case 'off':
      return { ...none, text: "Your station node's SSF wallet is switched off by SSF_CHIA_LANE in its environment, so the Bank cannot turn it on.", error: null, showsAddress: false };
    case 'on':
      // On, but the address did not read as a testnet11 one: nothing to pay.
      return { ...none, text: "Your node's SSF wallet is on, but its address did not read as a testnet11 address, so it is not shown.", error, showsAddress: false };
    case 'ready': {
      const label = w.seed ? 'TURN ON SSF WALLET' : 'CREATE SSF WALLET';
      // A raw-seed wallet from before the 24 words is retired, not loaded:
      // that is a CREATE, with its own warning, never a TURN ON.
      const legacy = !w.seed && w.legacy === true;
      if (ui.turning) {
        return { warning: null, notice: null, text: 'Turning your SSF wallet on…', error: null, button: { act: 'confirm', label: 'TURNING ON…', danger: false, busy: true }, showsAddress: false };
      }
      if (ui.armed) {
        return {
          text: 'Your station node has no SSF wallet on yet, so there is no address to pay.',
          warning: w.seed ? TURN_ON_WARNING : legacy ? CREATE_LEGACY_WARNING : CREATE_WARNING,
          notice: null,
          error,
          button: { act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false },
          showsAddress: false,
        };
      }
      return {
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
