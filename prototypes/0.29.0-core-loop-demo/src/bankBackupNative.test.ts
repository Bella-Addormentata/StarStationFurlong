/**
 * 🖥️ The native BACK UP: when the node says the desktop app's channel is on
 * (`chia_wallet.backup: "native"`) and the page runs in the app, BACK UP is
 * one button, OPEN BACKUP WINDOW, on any network the page knows. The page
 * never asks the node for the words, never marks them saved, and never holds
 * one. Anywhere else the page's own BACK UP is unchanged, and off a test
 * network it says to back up from the desktop app.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_DESKTOP,
  BACKUP_DONE,
  BACKUP_IDLE,
  BACKUP_NAG,
  BACKUP_WINDOW_ID,
  BACKUP_WINDOW_LABEL,
  BACKUP_WINDOW_LINES,
  applyBackupWindow,
  applyReveal,
  applySave,
  armSave,
  backupMode,
  bankBackupView,
  heldKeyRepeat,
  markWordsSaved,
  openBackupPanel,
  opensAfterTurnOn,
  reconcileBackupUi,
  resetBackupUi,
  revealWords,
  runBackupWindow,
  startBackupWindow,
  startReveal,
  startSave,
  type BackupWindowDeps,
  type BankBackupUi,
} from './bankBackup';
import { GATED_TEXT, bankWalletView } from './bankWallet';
import { MAINNET, TESTNET11, addressOn, type ChiaNetwork } from './chiaNetwork';
import { NATIVE_BACKUP_ANSWERS, openBackup, type NativeBackupAnswer } from './nativeShell';
import type { ChiaWalletBackup, ChiaWalletSwitch, LocalFingerprint } from './nodeFingerprint';

const BODY = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58);
const OTHER_BODY = 'zry9x8gf2tvdw0s3jn54khce6mua7lqp'.repeat(2).slice(0, 58);
/** 24 made-up words of the reveal's shape (a–z, 3 to 8 letters), none of
 *  them a BIP39 word: whatever the page holds, the native mode drops. */
const FAKE_WORDS = [
  'zorbel', 'quindle', 'vextra', 'plombu', 'gruntix', 'snarvel', 'thwimp', 'blorkus', 'frindle', 'zastro', 'kweemo', 'drubble',
  'mozzlet', 'squorp', 'trindax', 'glaven', 'pruxel', 'wombix', 'flunder', 'yeskit', 'clomber', 'zindra', 'vorpex', 'quastle',
];
const FAKE_KEY = 1234567;

const ON: ChiaWalletSwitch = { state: 'on', stays: true, mnemonic: true };
const fpOn = (net: ChiaNetwork, backup?: ChiaWalletBackup, extra: Partial<ChiaWalletSwitch> = {}, body = BODY): LocalFingerprint => ({
  hex: '00'.repeat(32),
  base64: 'A'.repeat(43) + '=',
  port: 4443,
  chia_net: net,
  chia_address: addressOn(net, body),
  chia_wallet: { ...ON, ...extra, ...(backup ? { backup } : {}) },
});

const THE_LINES: Record<NativeBackupAnswer, string> = {
  saved: 'Saved: your node has your 24 words marked as written down.',
  closed: 'The backup window closed before CONFIRM, so your 24 words are not marked saved yet.',
  no_channel: 'The desktop app did not start this station node, so it cannot show the 24 words. Stop the other station node and restart Star Station.',
  other_network: 'Your station node runs on another Chia network than this app, so the app does not show its 24 words.',
  not_on: 'Your SSF wallet is not on, so there are no 24 words to show.',
  turning: 'Your SSF wallet is still turning on. Try again in a moment.',
  already_saved: 'Your 24 words are already marked saved, so they are not shown again.',
  busy: 'The backup window is open, or just closed. Try again in a few seconds.',
  unavailable: 'The desktop app could not open the backup window. Restart Star Station, or update it.',
};

/** The Bank's state and OPEN BACKUP WINDOW's page side, with the real
 *  `openBackup` over a stubbed app hook and a spy on every fetch. */
function harness(fp: LocalFingerprint | null, shell: boolean, invoke: (...args: unknown[]) => unknown) {
  const invokeSpy = vi.fn(invoke);
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: invokeSpy } });
  const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));
  vi.stubGlobal('fetch', fetchSpy);
  const state = { ui: { ...BACKUP_IDLE } as BankBackupUi, fp };
  const refresh = vi.fn(async () => state.fp);
  let clock = 1000;
  const deps: BackupWindowDeps = {
    get: () => state.ui,
    set: (next) => {
      state.ui = next;
    },
    fingerprint: () => state.fp,
    shell,
    open: openBackup,
    refresh,
    now: () => (clock += 100),
  };
  return { state, deps, invokeSpy, fetchSpy, refresh };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('backupMode', () => {
  it('is native only when the node says so and the page runs in the app', () => {
    for (const net of [TESTNET11, MAINNET]) {
      expect(backupMode(fpOn(net, 'native'), true)).toBe('native');
      expect(backupMode(fpOn(net, 'native'), false)).toBe(net.test ? 'page' : 'desktop');
      for (const backup of [undefined, 'page', 'none'] as const) {
        for (const shell of [true, false]) expect(backupMode(fpOn(net, backup), shell)).toBe(net.test ? 'page' : 'desktop');
      }
    }
    expect(backupMode(null, true)).toBe('desktop');
  });
});

describe('BACK UP in the native mode', () => {
  it.each([TESTNET11, MAINNET])('is one button, OPEN BACKUP WINDOW, on $name, with no word, grid, SHOW, COPY or CONFIRM', (net) => {
    const fp = fpOn(net, 'native');
    const v = bankBackupView(fp, BACKUP_IDLE, 'app', true)!;
    expect(v).toMatchObject({
      state: 'nag',
      line: BACKUP_NAG,
      open: false,
      elsewhere: null,
      window: { label: 'OPEN BACKUP WINDOW', busy: false },
      windowLine: null,
      panel: null,
    });
    expect(BACKUP_WINDOW_LABEL).toBe('OPEN BACKUP WINDOW');
    const json = JSON.stringify(v);
    for (const word of ['COPY', 'SHOW', 'CONFIRM', 'I SAVED']) expect(json).not.toContain(word);
    // A dev page under `tauri dev`, or any page the app's webview loads: the
    // app decides, not the page's origin.
    expect(bankBackupView(fp, BACKUP_IDLE, 'dev', true)?.window).not.toBeNull();
    expect(bankBackupView(fp, BACKUP_IDLE, 'elsewhere', true)?.window).not.toBeNull();
  });

  it('never opens the page\'s panel, and closes one that was open, words and key and all', () => {
    const page = fpOn(TESTNET11, 'page');
    const opened = openBackupPanel(BACKUP_IDLE, page, 1000, true);
    expect(opened.open).toBe(true);
    const s = startReveal(opened, 1500)!;
    const shown = applyReveal(s.ui, s.ticket, { ok: true, words: [...FAKE_WORDS], key: FAKE_KEY, address: addressOn(TESTNET11, BODY) }, true, 2000);
    expect(shown.words).toEqual(FAKE_WORDS);
    // The node restarted with the app's channel on: BACK UP turns native.
    const native = fpOn(TESTNET11, 'native');
    expect(openBackupPanel(BACKUP_IDLE, native, 3000, true)).toBe(BACKUP_IDLE);
    const after = reconcileBackupUi(shown, native, 3000, true, Date.now(), true);
    expect(after).toMatchObject({ open: false, words: null, key: null, address: null, revealing: false, armed: false });
    expect(after.gen).toBeGreaterThan(shown.gen);
    const v = bankBackupView(native, after, 'app', true)!;
    expect(v.panel).toBeNull();
    const json = JSON.stringify([v, after]);
    for (const w of FAKE_WORDS) expect(json).not.toContain(w);
    expect(json).not.toContain(String(FAKE_KEY));
  });

  it('drops a page reveal still out when BACK UP turns native: its words never land', () => {
    const page = fpOn(TESTNET11, 'page');
    const opened = openBackupPanel(BACKUP_IDLE, page, 1000, true);
    const s = startReveal(opened, 1500)!;
    expect(s.ui.revealing).toBe(true);
    // The node restarted with the app's channel on while SHOW was out.
    const native = fpOn(TESTNET11, 'native');
    const after = reconcileBackupUi(s.ui, native, 1800, true, Date.now(), true);
    expect(after).toMatchObject({ open: false, revealing: false, words: null, key: null, address: null });
    expect(after.gen).not.toBe(s.ticket);
    const landed = applyReveal(after, s.ticket, { ok: true, words: [...FAKE_WORDS], key: FAKE_KEY, address: addressOn(TESTNET11, BODY) }, true, 2000);
    expect(landed).toBe(after);
    expect(landed.words).toBeNull();
    expect(landed.key).toBeNull();
    const json = JSON.stringify([landed, bankBackupView(native, landed, 'app', true)]);
    for (const w of FAKE_WORDS) expect(json).not.toContain(w);
    expect(json).not.toContain(String(FAKE_KEY));
  });

  it('drops a page save still out when BACK UP turns native: the page records nothing saved', () => {
    const page = fpOn(TESTNET11, 'page');
    const s = startReveal(openBackupPanel(BACKUP_IDLE, page, 1000, true), 1500)!;
    const shown = applyReveal(s.ui, s.ticket, { ok: true, words: [...FAKE_WORDS], key: FAKE_KEY, address: addressOn(TESTNET11, BODY) }, true, 2000);
    const saving = startSave(armSave(shown, 2600));
    expect(saving.saving).toBe(true);
    const ticket = saving.saveTicket;
    expect(ticket).not.toBeNull();
    const native = fpOn(TESTNET11, 'native');
    const after = reconcileBackupUi(saving, native, 2800, true, Date.now(), true);
    expect(after).toMatchObject({ open: false, saving: false, saveTicket: null, words: null, key: null, address: null, savedFor: null });
    const landed = applySave(after, ticket, { ok: true, note: null }, 3000);
    expect(landed).toBe(after);
    expect(landed.savedFor).toBeNull();
    // Still the nag and its one button: the node, not the page, says saved.
    expect(bankBackupView(native, landed, 'app', true)).toMatchObject({ state: 'nag', window: { label: BACKUP_WINDOW_LABEL, busy: false } });
    const json = JSON.stringify(landed);
    for (const w of FAKE_WORDS) expect(json).not.toContain(w);
  });

  it('calls invoke("open_backup") with no argument, and never fetches the words or the saved mark', async () => {
    const h = harness(fpOn(MAINNET, 'native'), true, async () => 'saved');
    expect(await runBackupWindow(h.deps)).toBe('saved');
    expect(h.invokeSpy).toHaveBeenCalledTimes(1);
    expect(h.invokeSpy.mock.calls[0]).toEqual(['open_backup']);
    expect(h.fetchSpy).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([TESTNET11, MAINNET])('on $name, sends no fetch whatever the app answers', async (net) => {
    for (const answer of [...NATIVE_BACKUP_ANSWERS, 'junk']) {
      const h = harness(fpOn(net, 'native'), true, async () => answer);
      await runBackupWindow(h.deps);
      expect(h.fetchSpy).not.toHaveBeenCalled();
      const urls = h.fetchSpy.mock.calls.map((c) => String((c as unknown[])[0]));
      expect(urls.some((u) => u.includes('/api/chia/words'))).toBe(false);
    }
  });

  it.each([...NATIVE_BACKUP_ANSWERS])('maps %s to its line, then reads the fingerprint once', async (answer) => {
    const h = harness(fpOn(MAINNET, 'native'), true, async () => answer);
    expect(await runBackupWindow(h.deps)).toBe(answer);
    expect(h.state.ui.windowOpen).toBe(false);
    expect(h.state.ui.windowLine).toBe(THE_LINES[answer]);
    expect(BACKUP_WINDOW_LINES[answer]).toBe(THE_LINES[answer]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // The fingerprint is read after the answer has landed, not before.
    expect(h.refresh.mock.invocationCallOrder[0]).toBeGreaterThan(h.invokeSpy.mock.invocationCallOrder[0]);
    expect(bankBackupView(h.state.fp, h.state.ui, 'app', true)?.windowLine).toBe(THE_LINES[answer]);
  });

  it('maps a refusal (an app with no open_backup), an unknown answer or a non-string to the unavailable line, and reads the fingerprint once', async () => {
    const odd: Array<() => unknown> = [
      async () => { throw new Error('command open_backup not found'); },
      () => Promise.reject('not allowed'),
      async () => 'opened',
      async () => undefined,
      async () => ({ words: FAKE_WORDS }),
    ];
    for (const invoke of odd) {
      const h = harness(fpOn(MAINNET, 'native'), true, invoke);
      expect(await runBackupWindow(h.deps)).toBe('unavailable');
      expect(h.state.ui.windowLine).toBe(THE_LINES.unavailable);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.state.ui)).not.toContain(FAKE_WORDS[0]);
    }
  });

  it('words every answer plainly: no em-dash, no word of the wallet', () => {
    expect(Object.keys(BACKUP_WINDOW_LINES).sort()).toEqual([...NATIVE_BACKUP_ANSWERS, 'unavailable'].sort());
    for (const line of [...Object.values(BACKUP_WINDOW_LINES), BACKUP_DESKTOP]) {
      expect(line).not.toContain('—');
      expect(line.length).toBeLessThan(160);
    }
  });

  it('a second tap while the window is out does nothing, even across the Bank reopening', async () => {
    let answerWith: (a: string) => void = () => {};
    const h = harness(fpOn(MAINNET, 'native'), true, () => new Promise((resolve) => { answerWith = resolve; }));
    const first = runBackupWindow(h.deps);
    expect(h.state.ui.windowOpen).toBe(true);
    expect(bankBackupView(h.state.fp, h.state.ui, 'app', true)?.window).toEqual({ label: 'OPEN BACKUP WINDOW', busy: true });
    expect(await runBackupWindow(h.deps)).toBeNull();
    h.state.ui = resetBackupUi(h.state.ui);
    expect(h.state.ui.windowOpen).toBe(true);
    expect(await runBackupWindow(h.deps)).toBeNull();
    h.state.ui = reconcileBackupUi(h.state.ui, null, 5000, false, Date.now(), true);
    expect(h.state.ui.windowOpen).toBe(true);
    expect(h.invokeSpy).toHaveBeenCalledTimes(1);
    answerWith('closed');
    expect(await first).toBe('closed');
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // Free again once it answered.
    expect(h.state.ui.windowOpen).toBe(false);
    expect(startBackupWindow(h.state.ui, h.state.fp, true, 9000).windowOpen).toBe(true);
  });

  it('is free again after an answer, and a new tap clears the old line', async () => {
    const h = harness(fpOn(MAINNET, 'native'), true, async () => 'closed');
    await runBackupWindow(h.deps);
    expect(h.state.ui.windowLine).toBe(THE_LINES.closed);
    const started = startBackupWindow(h.state.ui, h.state.fp, true, 9000);
    expect(started).toMatchObject({ windowOpen: true, windowLine: null, changedAt: 9000 });
    expect(await runBackupWindow(h.deps)).toBe('closed');
    expect(h.invokeSpy).toHaveBeenCalledTimes(2);
  });

  it('does not go outside the native mode, for a wallet backed up, or with no wallet to back up', async () => {
    for (const [fp, shell] of [
      [fpOn(MAINNET, 'native'), false],
      [fpOn(TESTNET11, 'native'), false],
      [fpOn(TESTNET11, 'page'), true],
      [fpOn(MAINNET, 'none'), true],
      [fpOn(MAINNET), true],
      [fpOn(MAINNET, 'native', { backed_up: true }), true],
      [fpOn(MAINNET, 'native', { mnemonic: undefined }), true],
      [{ ...fpOn(MAINNET, 'native'), chia_wallet: { state: 'ready', backup: 'native' } }, true],
      [{ ...fpOn(MAINNET, 'native'), chia_net: null }, true],
      [null, true],
    ] as Array<[LocalFingerprint | null, boolean]>) {
      expect(startBackupWindow(BACKUP_IDLE, fp, shell, 1)).toBe(BACKUP_IDLE);
      const h = harness(fp, shell, async () => 'saved');
      expect(await runBackupWindow(h.deps)).toBeNull();
      expect(h.invokeSpy).not.toHaveBeenCalled();
      expect(h.refresh).not.toHaveBeenCalled();
      expect(bankBackupView(fp, BACKUP_IDLE, 'app', shell)?.window ?? null).toBeNull();
    }
  });

  it('an answer for no call out changes nothing', () => {
    expect(applyBackupWindow(BACKUP_IDLE, 'saved', 1)).toBe(BACKUP_IDLE);
  });

  it('keeps the nag, done and at-rest lines as they are; the answer line goes with the wallet', () => {
    const fp = fpOn(MAINNET, 'native', { at_rest: 'none', at_rest_next: 'dpapi' });
    const nag = bankBackupView(fp, BACKUP_IDLE, 'app', true)!;
    expect(nag.line).toBe(BACKUP_NAG);
    expect(nag.atRest).toHaveLength(1);
    const answered = applyBackupWindow(startBackupWindow(BACKUP_IDLE, fp, true, 1), 'saved', 2);
    const saved = fpOn(MAINNET, 'native', { at_rest: 'dpapi', backed_up: true });
    const after = reconcileBackupUi(answered, saved, 3, true, Date.now(), true);
    expect(after.windowLine).toBeNull();
    expect(bankBackupView(saved, after, 'app', true)).toMatchObject({ state: 'done', line: BACKUP_DONE, window: null, windowLine: null, panel: null });
    // Another round on the same wallet keeps it.
    const closed = applyBackupWindow(startBackupWindow(BACKUP_IDLE, fp, true, 1), 'closed', 2);
    expect(closed.windowFor).toBe(fp.chia_address);
    expect(reconcileBackupUi(closed, fp, 3, true, Date.now(), true)).toBe(closed);
  });

  it.each([TESTNET11, MAINNET])('on $name, drops the answer line for another address, a wallet not on, or no node', (net) => {
    const fp = fpOn(net, 'native');
    const closed = applyBackupWindow(startBackupWindow(BACKUP_IDLE, fp, true, 1), 'closed', 2);
    expect(closed.windowLine).toBe(THE_LINES.closed);
    const other = fpOn(net, 'native', {}, OTHER_BODY);
    const off: LocalFingerprint = { ...fp, chia_address: undefined, chia_wallet: { state: 'off', backup: 'native' } };
    for (const next of [other, off, null]) {
      const after = reconcileBackupUi(closed, next, 3, true, Date.now(), true);
      expect(after.windowLine).toBeNull();
      expect(after.windowFor).toBeNull();
      expect(after.windowOpen).toBe(false);
      expect(bankBackupView(next, after, 'app', true)?.windowLine ?? null).toBeNull();
    }
    // Wallet B's nag offers its own OPEN BACKUP WINDOW, with no line of A's,
    // and the line does not come back when wallet A does.
    const b = reconcileBackupUi(closed, other, 3, true, Date.now(), true);
    expect(bankBackupView(other, b, 'app', true)).toMatchObject({ state: 'nag', window: { label: BACKUP_WINDOW_LABEL, busy: false }, windowLine: null });
    expect(bankBackupView(fp, reconcileBackupUi(b, fp, 4, true, Date.now(), true), 'app', true)?.windowLine).toBeNull();
  });

  it('drops the answer line when BACK UP stops being native, so it never comes back', () => {
    const fp = fpOn(TESTNET11, 'native');
    const closed = applyBackupWindow(startBackupWindow(BACKUP_IDLE, fp, true, 1), 'closed', 2);
    // The node restarted without the app's channel: the page's BACK UP.
    const page = fpOn(TESTNET11, 'page');
    const flipped = reconcileBackupUi(closed, page, 3, true, Date.now(), true);
    expect(flipped).toMatchObject({ windowLine: null, windowFor: null });
    // And with the channel on again: no old line.
    const back = reconcileBackupUi(flipped, fp, 4, true, Date.now(), true);
    expect(bankBackupView(fp, back, 'app', true)?.windowLine).toBeNull();
    // The same goes for the app no longer answering commands.
    expect(reconcileBackupUi(closed, fp, 3, true, Date.now(), false).windowLine).toBeNull();
  });

  it('keeps the answer of a window still out across the Bank reopening, for the same wallet', () => {
    const fp = fpOn(MAINNET, 'native');
    const out = startBackupWindow(BACKUP_IDLE, fp, true, 1);
    const reopened = resetBackupUi(out);
    expect(reopened).toMatchObject({ windowOpen: true, windowFor: fp.chia_address });
    const answered = applyBackupWindow(reopened, 'closed', 2);
    expect(reconcileBackupUi(answered, fp, 3, true, Date.now(), true)).toBe(answered);
    expect(bankBackupView(fp, answered, 'app', true)?.windowLine).toBe(THE_LINES.closed);
    // An answer that landed while the Bank was closed is still there when
    // it opens again, for the same wallet, and goes with that wallet.
    const again = resetBackupUi(answered);
    expect(again).toMatchObject({ windowOpen: false, windowLine: THE_LINES.closed, windowFor: fp.chia_address });
    expect(bankBackupView(fp, reconcileBackupUi(again, fp, 4, true, Date.now(), true), 'app', true)?.windowLine).toBe(THE_LINES.closed);
    expect(reconcileBackupUi(again, null, 4, true, Date.now(), true)).toMatchObject({ windowLine: null, windowFor: null });
  });

  it('drops the answer of a window whose wallet went away while it was out, even if the wallet came back', () => {
    for (const net of [TESTNET11, MAINNET]) {
      const fp = fpOn(net, 'native');
      const off = { ...fp, chia_address: undefined, chia_wallet: { ...fp.chia_wallet!, state: 'off' } } as LocalFingerprint;
      for (const away of [null, off, fpOn(net, 'page'), fpOn(net, 'native', {}, OTHER_BODY)]) {
        const out = startBackupWindow(BACKUP_IDLE, fp, true, 1);
        const left = reconcileBackupUi(out, away, 2, true, Date.now(), true);
        expect(left).toMatchObject({ windowOpen: true, windowFor: null });
        // One window at a time still: no second one goes while it is out.
        expect(startBackupWindow(left, fp, true, 3)).toBe(left);
        const back = reconcileBackupUi(left, fp, 3, true, Date.now(), true);
        const answered = applyBackupWindow(back, 'closed', 4);
        expect(answered).toMatchObject({ windowOpen: false, windowLine: null, windowFor: null });
        expect(bankBackupView(fp, answered, 'app', true)?.windowLine).toBeNull();
      }
    }
  });

  it('turns TURN ON into the app\'s window, on any network the page knows', () => {
    const ready = { ...fpOn(MAINNET, 'native'), chia_address: undefined, chia_wallet: { state: 'ready', mnemonic: true, backup: 'native' } } as LocalFingerprint;
    for (const net of [TESTNET11, MAINNET]) {
      const after = fpOn(net, 'native');
      expect(opensAfterTurnOn(ready, after, 'app', true)).toBe(true);
      expect(opensAfterTurnOn(ready, after, 'elsewhere', true)).toBe(true);
      expect(opensAfterTurnOn(after, after, 'app', true)).toBe(false);
      expect(opensAfterTurnOn(ready, fpOn(net, 'native', { backed_up: true }), 'app', true)).toBe(false);
    }
  });

  it('stops a held Enter on OPEN BACKUP WINDOW', () => {
    expect(BACKUP_WINDOW_ID).toBe('bank-backup-window');
    expect(heldKeyRepeat({ repeat: true, key: 'Enter' }, BACKUP_WINDOW_ID)).toBe(true);
    expect(heldKeyRepeat({ repeat: false, key: 'Enter' }, BACKUP_WINDOW_ID)).toBe(false);
  });
});

describe('the page\'s BACK UP, unchanged without IPC or without backup "native"', () => {
  const ADDR = addressOn(TESTNET11, BODY);

  it.each([
    ['native, but no IPC', 'native', false],
    ['page, in the app', 'page', true],
    ['page, in a browser', 'page', false],
    ['none, in the app', 'none', true],
    ['absent (an older node), in the app', undefined, true],
    ['absent (an older node), in a browser', undefined, false],
  ] as Array<[string, ChiaWalletBackup | undefined, boolean]>)('on testnet11 with %s', async (_name, backup, shell) => {
    const fp = fpOn(TESTNET11, backup);
    const old: LocalFingerprint = { ...fp, chia_wallet: { ...ON } };
    // Every view, every move, as for a node that never says `backup`.
    const opened = openBackupPanel(BACKUP_IDLE, fp, 1000, shell);
    expect(opened).toEqual(openBackupPanel(BACKUP_IDLE, old, 1000));
    expect(opened.open).toBe(true);
    const s = startReveal(opened, 1500)!;
    const shown = applyReveal(s.ui, s.ticket, { ok: true, words: [...FAKE_WORDS], key: FAKE_KEY, address: ADDR }, true, 2000);
    for (const ui of [BACKUP_IDLE, opened, shown]) {
      for (const page of ['app', 'dev', 'elsewhere'] as const) {
        expect(bankBackupView(fp, ui, page, shell)).toEqual(bankBackupView(old, ui, page));
      }
      expect(reconcileBackupUi(ui, fp, 2500, true, 2500, shell)).toEqual(reconcileBackupUi(ui, old, 2500, true, 2500));
    }
    const p = bankBackupView(fp, shown, 'app', shell)!;
    expect(p.window).toBeNull();
    expect(p.panel?.words).toEqual(FAKE_WORDS);
    expect(p.panel?.copy).toBe(true);
    const ready = { ...fp, chia_address: undefined, chia_wallet: { state: 'ready', mnemonic: true } } as LocalFingerprint;
    expect(opensAfterTurnOn(ready, fp, 'app', shell)).toBe(true);
    expect(opensAfterTurnOn(ready, fp, 'elsewhere', shell)).toBe(false);
    // The page's reveal still goes to the node, as before.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, words: FAKE_WORDS, key: FAKE_KEY, address: ADDR }), { status: 200 }));
    expect(await revealWords('http://127.0.0.1:8081', ADDR, fp.chia_net, fetchImpl as unknown as typeof fetch)).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // And OPEN BACKUP WINDOW does not go.
    const h = harness(fp, shell, async () => 'saved');
    expect(await runBackupWindow(h.deps)).toBeNull();
    expect(h.invokeSpy).not.toHaveBeenCalled();
  });
});

describe('BACK UP on Chia mainnet', () => {
  it('only native, in the app, offers a button; anything else says to use the desktop app', () => {
    for (const backup of [undefined, 'page', 'none', 'native'] as const) {
      for (const shell of [true, false]) {
        const fp = fpOn(MAINNET, backup);
        for (const page of ['app', 'dev', 'elsewhere'] as const) {
          const v = bankBackupView(fp, BACKUP_IDLE, page, shell)!;
          expect(v.panel).toBeNull();
          expect(v.open).toBe(false);
          if (backup === 'native' && shell) {
            expect(v.window).toEqual({ label: 'OPEN BACKUP WINDOW', busy: false });
            expect(v.elsewhere).toBeNull();
          } else {
            expect(v).toMatchObject({ state: 'nag', line: BACKUP_NAG, window: null, windowLine: null, elsewhere: 'Back up from the Star Station desktop app on this computer.' });
            expect(BACKUP_DESKTOP).toBe('Back up from the Star Station desktop app on this computer.');
          }
        }
        expect(openBackupPanel(BACKUP_IDLE, fp, 1, shell)).toBe(BACKUP_IDLE);
        const ready = { ...fp, chia_address: undefined, chia_wallet: { state: 'ready', mnemonic: true } } as LocalFingerprint;
        expect(opensAfterTurnOn(ready, fp, 'app', shell)).toBe(backup === 'native' && shell);
      }
    }
  });

  it('says the words are backed up when the node says so, whatever the mode', () => {
    for (const backup of [undefined, 'none', 'native'] as const) {
      for (const shell of [true, false]) {
        expect(bankBackupView(fpOn(MAINNET, backup, { backed_up: true }), BACKUP_IDLE, 'app', shell)).toMatchObject({ state: 'done', line: BACKUP_DONE, window: null, open: false, panel: null });
      }
    }
  });

  it('keeps refusing the page\'s reveal and saved mark before anything is sent, even in the native mode', async () => {
    const fp = fpOn(MAINNET, 'native');
    const never = vi.fn();
    expect(await revealWords('http://127.0.0.1:8081', fp.chia_address!, MAINNET, never as unknown as typeof fetch)).toMatchObject({ ok: false });
    expect(await markWordsSaved('http://127.0.0.1:8081', FAKE_KEY, MAINNET, never as unknown as typeof fetch)).toMatchObject({ ok: false });
    expect(never).not.toHaveBeenCalled();
  });

  it('shows nothing for another address, an unknown network, or a wallet that is not on', () => {
    // Another address is its own wallet: its own button, and no line of the
    // last wallet's answer.
    const closed = applyBackupWindow(startBackupWindow(BACKUP_IDLE, fpOn(MAINNET, 'native'), true, 1), 'closed', 2);
    const other = fpOn(MAINNET, 'native', {}, OTHER_BODY);
    expect(bankBackupView(other, reconcileBackupUi(closed, other, 3, true, Date.now(), true), 'app', true)).toMatchObject({
      window: { label: BACKUP_WINDOW_LABEL, busy: false },
      windowLine: null,
    });
    expect(bankBackupView({ ...fpOn(MAINNET, 'native'), chia_net: null }, BACKUP_IDLE, 'app', true)).toBeNull();
    expect(bankBackupView({ ...fpOn(MAINNET), chia_net: null }, BACKUP_IDLE, 'app', false)).toBeNull();
    const gated: LocalFingerprint = { ...fpOn(MAINNET, 'none'), chia_address: undefined, chia_wallet: { state: 'gated', backup: 'none' } };
    expect(bankBackupView(gated, BACKUP_IDLE, 'app', true)).toBeNull();
    // GATED_TEXT stays for a node that still reports gated.
    expect(bankWalletView(gated, { armed: false, turning: false, error: null }).text).toBe(GATED_TEXT);
    expect(bankWalletView({ ...gated, chia_wallet: { state: 'gated', backup: 'native' } }, { armed: false, turning: false, error: null }).text).toBe(GATED_TEXT);
  });
});
