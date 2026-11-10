/**
 * ⛓️ When the page asks the node for the SSF wallet's coins (#415). Off a test
 * network the node reads them only for a faucet request that carries
 * `wallet: true`, and each such read shows the full nodes asked which money
 * address belongs to this IP. So the page sets the flag only while RECEIVE's
 * balance is on screen: the phone out, the Bank its view, the page not
 * hidden. A read that comes due off screen is owed, and sent when the Bank is
 * back.
 *
 * The functions are taken out of main.ts by the compiler and run against
 * stand-ins: vitest has no DOM here, and main.ts cannot be imported (it
 * starts the game).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');

const WANTED = ['treasuryViewOnScreen', 'bankViewOnScreen', 'bankBalanceOwed', 'requestBankBalance', 'statusAsksForBalance'];

interface Sent { op: string; amount: unknown; wallet: unknown }
interface Fingerprint { chia_address?: string; chia_lane?: { off: boolean } }

/** The page as the functions see it: what is on screen, the room, the node's
 *  fingerprint, and every faucet request sent. */
function page() {
  const file = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
  const parts = file.statements.filter((s) => {
    if (ts.isFunctionDeclaration(s)) return WANTED.includes(s.name?.text ?? '');
    if (!ts.isVariableStatement(s)) return false;
    const name = s.declarationList.declarations[0]?.name;
    return name !== undefined && ts.isIdentifier(name) && WANTED.includes(name.text);
  });
  const js = ts.transpileModule(parts.map((s) => s.getText(file)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const screen = { phoneOut: true, bankIsView: true, hidden: false };
  const sent: Sent[] = [];
  const failed: unknown[][] = [];
  const classes = (on: () => boolean) => ({ classList: { contains: (c: string) => c === 'active' && on() } });
  const world: {
    activeBootstrap: { roomId: string } | null;
    localFingerprint: Fingerprint | null;
    refuse: boolean;
  } = { activeBootstrap: { roomId: 'room-1' }, localFingerprint: { chia_address: 'xch1qqqq' }, refuse: false };
  const realm = vm.createContext({
    document: {
      getElementById: (id: string) =>
        id === 'spacephone-container' ? classes(() => screen.phoneOut)
          : id === 'phone-app-bank' ? classes(() => screen.bankIsView)
            : null,
      get visibilityState() {
        return screen.hidden ? 'hidden' : 'visible';
      },
    },
    get activeBootstrap() {
      return world.activeBootstrap;
    },
    get localFingerprint() {
      return world.localFingerprint;
    },
    networkProvider: {
      requestFaucet: (op: string, amount: unknown, wallet: unknown) => {
        sent.push({ op, amount, wallet });
        return { seq: sent.length, sent: world.refuse ? Promise.reject(new Error('no stream')) : Promise.resolve() };
      },
    },
    failFaucetRequest: (...args: unknown[]) => {
      failed.push(args);
    },
  });
  type Fns = { requestBankBalance: () => void; statusAsksForBalance: () => boolean; owed: () => boolean };
  const fns = parts.length === WANTED.length
    ? (vm.runInContext(`${js}\n({ requestBankBalance, statusAsksForBalance, owed: () => bankBalanceOwed });`, realm) as Fns)
    : null;
  return { found: parts.length, fns: fns!, screen, world, sent, failed };
}

describe('the Bank asks for the wallet\'s coins only while its balance is on screen', () => {
  it('finds the functions in main.ts', () => {
    expect(page().found).toBe(WANTED.length);
  });

  it('says a status asks only with the phone out, the Bank its view, and the page shown', () => {
    const p = page();
    expect(p.fns.statusAsksForBalance()).toBe(true);
    // Tab puts the phone away and leaves `active` on the Bank's view.
    p.screen.phoneOut = false;
    expect(p.fns.statusAsksForBalance()).toBe(false);
    p.screen.phoneOut = true;
    // Another app is the phone's view.
    p.screen.bankIsView = false;
    expect(p.fns.statusAsksForBalance()).toBe(false);
    p.screen.bankIsView = true;
    // A minimised window or a background tab: its timers still run.
    p.screen.hidden = true;
    expect(p.fns.statusAsksForBalance()).toBe(false);
    p.screen.hidden = false;
    expect(p.fns.statusAsksForBalance()).toBe(true);
  });

  it('sends the Bank\'s own read, by name, with the balance on screen', () => {
    const p = page();
    p.fns.requestBankBalance();
    expect(p.sent).toEqual([{ op: 'status', amount: undefined, wallet: true }]);
    expect(p.fns.owed()).toBe(false);
  });

  it.each([
    ['the phone was put away', (s: { phoneOut: boolean }) => { s.phoneOut = false; }, (s: { phoneOut: boolean }) => { s.phoneOut = true; }],
    ['another app is the phone\'s view', (s: { bankIsView: boolean }) => { s.bankIsView = false; }, (s: { bankIsView: boolean }) => { s.bankIsView = true; }],
    ['the page is hidden', (s: { hidden: boolean }) => { s.hidden = true; }, (s: { hidden: boolean }) => { s.hidden = false; }],
  ] as const)('sends nothing when %s, and owes the read until the Bank is back', (_why, away, back) => {
    const p = page();
    away(p.screen);
    // A wallet turned on whose answer landed after the Bank left the screen.
    p.fns.requestBankBalance();
    expect(p.sent).toEqual([]);
    expect(p.fns.owed()).toBe(true);
    // Asked again while still away (another class change, say): still nothing.
    p.fns.requestBankBalance();
    expect(p.sent).toEqual([]);
    expect(p.fns.owed()).toBe(true);
    // Back on screen, the screen watch sends it, once.
    back(p.screen);
    p.fns.requestBankBalance();
    expect(p.sent).toEqual([{ op: 'status', amount: undefined, wallet: true }]);
    expect(p.fns.owed()).toBe(false);
  });

  it('asks nothing, and owes nothing, with no room, no wallet or Chia off', () => {
    const p = page();
    p.world.activeBootstrap = null;
    p.fns.requestBankBalance();
    p.world.activeBootstrap = { roomId: 'room-1' };
    p.world.localFingerprint = null;
    p.fns.requestBankBalance();
    p.world.localFingerprint = {};
    p.fns.requestBankBalance();
    p.world.localFingerprint = { chia_address: 'xch1qqqq', chia_lane: { off: true } };
    p.fns.requestBankBalance();
    expect(p.sent).toEqual([]);
    expect(p.fns.owed()).toBe(false);
    // A read owed from before is dropped by one that finds nothing to ask.
    p.world.localFingerprint = { chia_address: 'xch1qqqq' };
    p.screen.phoneOut = false;
    p.fns.requestBankBalance();
    expect(p.fns.owed()).toBe(true);
    p.world.localFingerprint = null;
    p.fns.requestBankBalance();
    expect(p.fns.owed()).toBe(false);
  });

  it('files a read that could not leave with the dish\'s store', async () => {
    const p = page();
    p.world.refuse = true;
    p.fns.requestBankBalance();
    await new Promise((r) => setTimeout(r, 0));
    expect(p.failed).toHaveLength(1);
    expect(p.failed[0].slice(0, 3)).toEqual(['room-1', 'status', 1]);
  });
});

describe('main.ts sends no faucet request that asks for the wallet past that rule', () => {
  const body = (head: string): string => {
    const at = main.indexOf(head);
    expect(at, head).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n}\n', at));
  };

  it('has three senders: the Bank\'s read behind the gate, and the dish\'s two under the rule', () => {
    expect(main.split('networkProvider.requestFaucet(').length - 1).toBe(3);
    expect(main).toContain('world.onFaucetRequest = (op, amount) => networkProvider.requestFaucet(op, amount, statusAsksForBalance());');
    expect(main).toContain('if (world.hasFaucetDish()) networkProvider.requestFaucet("status", undefined, statusAsksForBalance()).sent.catch(() => {});');
    const ask = body('function requestBankBalance(): void {');
    const gate = ask.indexOf('if (!statusAsksForBalance()) {\n    bankBalanceOwed = true;\n    return;\n  }');
    expect(gate).toBeGreaterThan(0);
    // The one sender that asks outright comes after the gate.
    expect(ask.indexOf('networkProvider.requestFaucet("status", undefined, true)')).toBeGreaterThan(gate);
  });

  it('sends the owed read when the Bank is back: on the phone\'s and the view\'s class changes, and when the page is shown', () => {
    const render = body('function renderBankApp(): void {');
    expect(render).toContain(
      'const watch = new MutationObserver(() => {\n'
      + '      if (!treasuryViewOnScreen(view)) bankBackupLeftScreen();\n'
      + '      // ⛓️ Back on screen: the balance read that waited for it.\n'
      + '      else if (bankBalanceOwed) requestBankBalance();\n'
      + '    });\n'
      + '    watch.observe(view, { attributes: true, attributeFilter: ["class"] });\n'
      + '    if (phone) watch.observe(phone, { attributes: true, attributeFilter: ["class"] });',
    );
    expect(render).toContain(
      'document.addEventListener("visibilitychange", () => {\n'
      + '      if (document.visibilityState === "hidden") bankBackupLeftScreen();\n'
      + '      // ⛓️ Shown again: the balance read that waited for it.\n'
      + '      else if (bankBalanceOwed) requestBankBalance();\n'
      + '    });',
    );
  });

  it('reads the balance through that one function after a wallet is turned on, on open and on REFRESH', () => {
    expect(body('async function turnBankWallet(')).toContain('if (turned.ok && on) requestBankBalance();');
    expect(main).toContain('#bank-refresh-balance")?.addEventListener("click", () => requestBankBalance());');
    const at = main.indexOf('if (id === "bank") {');
    expect(at).toBeGreaterThan(0);
    expect(main.slice(at, main.indexOf('\n    }\n', at))).toContain('requestBankBalance();');
  });
});
