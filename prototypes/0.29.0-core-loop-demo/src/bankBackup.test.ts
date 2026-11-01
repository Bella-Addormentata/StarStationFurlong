/**
 * 🏦 BACK UP in the Bank: what RECEIVE shows about the 24 words, how the
 * page's state follows the node and the screen, the two requests, the
 * clipboard, and the grid's markup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_GRID_ID,
  BACKUP_IDLE,
  BACKUP_SAVED_ID,
  BACKUP_SHOW_ID,
  CLIPBOARD_WIPE_MS,
  WORDS_SHOWN_MS,
  afterAddressCopy,
  afterCopy,
  afterWipe,
  applyReveal,
  applySave,
  armSave,
  backupGridHtml,
  backupPageKind,
  bankBackupView,
  clipboardWipeDue,
  closeBackupPanel,
  copyWords,
  freshTap,
  heldKeyRepeat,
  hideWords,
  markWordsSaved,
  openBackupPanel,
  opensAfterTurnOn,
  reconcileBackupUi,
  resetBackupUi,
  revealWords,
  startReveal,
  startSave,
  wipeClipboard,
  wipeWanted,
  wordsExpireIn,
  type BankBackupUi,
  type RevealResult,
} from './bankBackup';
import { BANK_WALLET_BUTTON_ID } from './bankWallet';
import type { ChiaWalletSwitch, LocalFingerprint } from './nodeFingerprint';

const BASE: LocalFingerprint = { hex: '00'.repeat(32), base64: 'A'.repeat(43) + '=', port: 4443 };
const ADDR = 'txch1' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58);
const OTHER = 'txch1' + 'zry9x8gf2tvdw0s3jn54khce6mua7lqp'.repeat(2).slice(0, 58);
const node = (chia_wallet?: ChiaWalletSwitch, chia_address?: string): LocalFingerprint => ({
  ...BASE,
  ...(chia_wallet ? { chia_wallet } : {}),
  ...(chia_address ? { chia_address } : {}),
});
const ON: ChiaWalletSwitch = { state: 'on', stays: true, mnemonic: true };
const LIVE = node(ON, ADDR);
/** 24 distinct words (the first 24 of the BIP39 English list). The sample
 *  need not be a valid mnemonic: the grid only has to keep each one out of
 *  the masked markup and out of every attribute. */
const WORDS = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident',
  'account', 'accuse', 'achieve', 'acid', 'acoustic', 'acquire', 'across', 'act', 'action', 'actor', 'actress', 'actual',
];
const KEY = 3552866753;
const has = (text: string, word: string) => new RegExp(`\\b${word}\\b`).test(text);

/** The panel open on LIVE at t=1000, then shown at t=2000. */
const opened = (): BankBackupUi => openBackupPanel(BACKUP_IDLE, LIVE, 1000);
const shown = (): BankBackupUi => {
  const s = startReveal(opened(), 1500)!;
  return applyReveal(s.ui, s.ticket, { ok: true, words: [...WORDS], key: KEY, address: ADDR }, true, 2000);
};

describe('backupPageKind', () => {
  it('is the app for the desktop WebView, dev for a loopback page, elsewhere for the rest', () => {
    expect(backupPageKind({ protocol: 'tauri:', hostname: 'localhost' })).toBe('app');
    expect(backupPageKind({ protocol: 'http:', hostname: 'tauri.localhost' })).toBe('app');
    expect(backupPageKind({ protocol: 'https:', hostname: 'TAURI.localhost' })).toBe('app');
    for (const hostname of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
      expect(backupPageKind({ protocol: 'http:', hostname })).toBe('dev');
    }
    for (const [protocol, hostname] of [['https:', 'starstation.example'], ['http:', '192.168.1.5'], ['file:', ''], ['http:', 'localhost.example'], ['ftp:', 'localhost']]) {
      expect(backupPageKind({ protocol, hostname })).toBe('elsewhere');
    }
  });
});

describe('bankBackupView', () => {
  it('shows nothing where there is nothing to back up', () => {
    for (const fp of [
      null,
      undefined,
      node(undefined, ADDR), // an older node: no switch at all
      node({ state: 'on', stays: true }, ADDR), // an older node's switch: no `mnemonic`
      node({ state: 'ready' }),
      node({ state: 'ready', legacy: true }),
      node({ state: 'off' }),
      node({ state: 'unbuilt' }),
      node({ ...ON }), // on, but no address
      node({ ...ON }, 'xch1' + ADDR.slice(5)), // not a testnet11 address
    ]) {
      expect(bankBackupView(fp, BACKUP_IDLE, 'app')).toBeNull();
    }
  });

  it('nags with BACK UP, keeping the address in view, until the panel opens', () => {
    const v = bankBackupView(LIVE, BACKUP_IDLE, 'app')!;
    expect(v).toMatchObject({ state: 'nag', open: true, elsewhere: null, panel: null, error: null });
    expect(v.line).toContain('not backed up');
    expect(v.line).toContain('no other Chia wallet can open it');
    expect(bankBackupView(LIVE, BACKUP_IDLE, 'dev')).toMatchObject({ state: 'nag', open: true });
  });

  it('on any other page says to open the app, and offers no BACK UP', () => {
    const v = bankBackupView(LIVE, opened(), 'elsewhere')!;
    expect(v).toMatchObject({ state: 'nag', open: false, panel: null });
    expect(v.elsewhere).toBe('Open the Star Station app on this computer to back up the 24 words.');
  });

  it('opens masked, with I SAVED really disabled until a reveal', () => {
    const v = bankBackupView(LIVE, opened(), 'app')!;
    expect(v.state).toBe('panel');
    expect(v.line).toBeNull();
    const p = v.panel!;
    expect(p.title).toBe('BACK UP — YOUR 24 WORDS');
    expect(p.warning).toContain('Write them on paper, in order');
    expect(p.warning).toContain('nobody can see your screen or your stream');
    expect(p.words).toBeNull();
    expect(p.show).toEqual({ act: 'show', label: 'SHOW', busy: false });
    expect(p.copy).toBe(false);
    expect(p.saved).toEqual({ act: 'arm', label: 'I SAVED', danger: false, busy: false, disabled: true });
    expect(p.keyLine).toBeNull();
    expect(p.funding).toBeNull();
  });

  it('walks through revealing, shown, hidden, armed, saving and done', () => {
    const s = startReveal(opened(), 1500)!;
    const revealing = bankBackupView(LIVE, s.ui, 'app')!.panel!;
    expect(revealing.show).toEqual({ act: 'show', label: 'SHOWING…', busy: true });
    expect(revealing.words).toBeNull();

    const ui = shown();
    const p = bankBackupView(LIVE, ui, 'app')!.panel!;
    expect(p.words).toEqual(WORDS);
    expect(p.show).toEqual({ act: 'hide', label: 'HIDE', busy: false });
    expect(p.copy).toBe(true);
    expect(p.saved).toMatchObject({ act: 'arm', label: 'I SAVED', disabled: false });
    expect(p.keyLine).toContain(`Key fingerprint ${KEY}`);
    expect(p.keyLine).toContain('not to spend while your node');
    expect(p.funding).toEqual({
      text: 'Fund your node only at the address shown here. Sage and the Chia wallet show other addresses of the same words, which your node does not watch.',
      address: ADDR,
    });

    // Hidden after a reveal: masked again, I SAVED still offered (the key is kept, the words are not).
    const hidden = hideWords(ui, 3000);
    expect(hidden.words).toBeNull();
    expect(hidden.key).toBe(KEY);
    const hp = bankBackupView(LIVE, hidden, 'app')!.panel!;
    expect(hp).toMatchObject({ words: null, copy: false, show: { act: 'show', label: 'SHOW' } });
    expect(hp.saved).toMatchObject({ label: 'I SAVED', disabled: false });

    const armed = armSave(hidden, 4000);
    const ap = bankBackupView(LIVE, armed, 'app')!.panel!;
    expect(ap.saved).toEqual({ act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false, disabled: false });
    expect(ap.armedWarning).toBe('Written all 24, in order? The Bank stops asking and will not show them again. Tap CONFIRM.');

    const saving = startSave(armed);
    const sp = bankBackupView(LIVE, saving, 'app')!.panel!;
    expect(sp.saved).toEqual({ act: 'confirm', label: 'SAVING…', danger: false, busy: true, disabled: false });
    expect(sp.armedWarning).toBeNull();

    const done = bankBackupView(node({ ...ON, backed_up: true }, ADDR), BACKUP_IDLE, 'app')!;
    expect(done).toMatchObject({ state: 'done', open: false, panel: null });
    expect(done.line).toContain('backed up');
    expect(done.line).toContain('does not show them again');
    // Done on the page's word too, until the fingerprint catches up.
    const saved = applySave(saving, { ok: true, note: null }, 5000);
    expect(bankBackupView(LIVE, saved, 'app')).toMatchObject({ state: 'done', panel: null });
    expect(saved).toMatchObject({ open: false, words: null, key: null, savedFor: ADDR });
  });

  it('words what the clipboard holds, and the expiry', () => {
    const ui = shown();
    const notice = (copy: BankBackupUi['copy'], open = true) =>
      bankBackupView(LIVE, { ...ui, copy, open }, 'app')!.copyNotice;
    expect(notice('none')).toBeNull();
    const held = notice('held')!;
    expect(held).toContain('COPIED');
    expect(held).toContain('Win+V');
    expect(held).toContain('cloud clipboard sync');
    expect(held).toContain('paper is safer');
    expect(notice('stuck')).toContain('may still hold the 24 words');
    expect(notice('refused')).toContain('write the words from the grid');
    expect(notice('wiped')).toContain('emptied the clipboard');
    // Outside the panel only a clipboard that may hold the words, or was emptied, is mentioned.
    expect(notice('stuck', false)).toContain('may still hold the 24 words');
    expect(notice('wiped', false)).toContain('emptied');
    expect(notice('held', false)).toBeNull();
    expect(notice('refused', false)).toBeNull();

    const expired = reconcileBackupUi(ui, LIVE, 2000 + WORDS_SHOWN_MS, true);
    expect(bankBackupView(LIVE, expired, 'app')!.panel!.expired).toBe('Hidden after 5 minutes. Tap SHOW to see them again.');
    expect(bankBackupView(LIVE, ui, 'app')!.panel!.expired).toBeNull();
  });
});

describe('reconcileBackupUi', () => {
  it('closes the panel and forgets words and key when the wallet they were for is gone', () => {
    const ui = shown();
    for (const fp of [
      node(ON, OTHER), // another address
      node({ state: 'ready', seed: true }), // left `on`
      node({ state: 'on', stays: true }, ADDR), // `mnemonic` disappeared
      node({ ...ON, backed_up: true }, ADDR), // backed up
      null, // the node is gone
    ]) {
      const r = reconcileBackupUi(ui, fp, 2500, true);
      expect(r).toMatchObject({ open: false, words: null, key: null, address: null, revealing: false, armed: false, saving: false });
      expect(r.gen).toBeGreaterThan(ui.gen);
    }
  });

  it('changes nothing when only something else in the fingerprint changed', () => {
    const ui = shown();
    const fp = { ...LIVE, reachability: 'cgnat', iroh_port: 11204, chia_wallet: { ...ON, held: true } };
    expect(reconcileBackupUi(ui, fp, 2500, true)).toBe(ui);
    expect(reconcileBackupUi(BACKUP_IDLE, null, 2500, false)).toBe(BACKUP_IDLE);
  });

  it('drops the words and a reveal in flight whenever the Bank is not on screen', () => {
    const ui = shown();
    const off = reconcileBackupUi(ui, LIVE, 2500, false);
    expect(off).toMatchObject({ open: true, words: null, key: KEY });
    expect(off.gen).toBeGreaterThan(ui.gen);
    // A reveal asked before the Bank left is dropped when it lands, even back on screen.
    const s = startReveal(opened(), 1500)!;
    const left = reconcileBackupUi(s.ui, LIVE, 1600, false);
    expect(left.revealing).toBe(false);
    const late = applyReveal(left, s.ticket, { ok: true, words: [...WORDS], key: KEY, address: ADDR }, true, 1700);
    expect(late.words).toBeNull();
  });

  it('hides the words at 300 000 ms', () => {
    const ui = shown();
    expect(reconcileBackupUi(ui, LIVE, 2000 + WORDS_SHOWN_MS - 1, true)).toBe(ui);
    expect(wordsExpireIn(ui, 2000 + WORDS_SHOWN_MS - 1)).toBe(1);
    const r = reconcileBackupUi(ui, LIVE, 2000 + WORDS_SHOWN_MS, true);
    expect(r).toMatchObject({ words: null, expired: true, key: KEY, open: true });
    expect(wordsExpireIn(r, 2000 + WORDS_SHOWN_MS)).toBeNull();
  });

  it('lets the page\'s own "saved" stand only until the node agrees, for the same wallet', () => {
    const saved = { ...BACKUP_IDLE, savedFor: ADDR };
    expect(reconcileBackupUi(saved, LIVE, 1, true)).toBe(saved);
    expect(reconcileBackupUi(saved, node({ ...ON, backed_up: true }, ADDR), 1, true).savedFor).toBeNull();
    expect(reconcileBackupUi(saved, node(ON, OTHER), 1, true).savedFor).toBeNull();
    expect(bankBackupView(node(ON, OTHER), saved, 'app')!.state).toBe('nag');
  });
});

describe('the panel\'s moves', () => {
  it('opens only for a wallet to back up, and drops a late reveal once closed or reopened', () => {
    expect(openBackupPanel(BACKUP_IDLE, node({ ...ON, backed_up: true }, ADDR), 1)).toBe(BACKUP_IDLE);
    expect(openBackupPanel(BACKUP_IDLE, null, 1)).toBe(BACKUP_IDLE);
    const s = startReveal(opened(), 1500)!;
    const ok: RevealResult = { ok: true, words: [...WORDS], key: KEY, address: ADDR };
    expect(applyReveal(closeBackupPanel(s.ui, 1600), s.ticket, ok, true, 1700).words).toBeNull();
    const reopened = openBackupPanel(closeBackupPanel(s.ui, 1600), LIVE, 1650);
    expect(applyReveal(reopened, s.ticket, ok, true, 1700).words).toBeNull();
    // A reveal that lands while the Bank is off screen is dropped, not stored.
    const offScreen = applyReveal(s.ui, s.ticket, ok, false, 1700);
    expect(offScreen).toMatchObject({ words: null, key: null, revealing: false });
    expect(startReveal(BACKUP_IDLE, 1)).toBeNull();
    expect(startReveal(s.ui, 1)).toBeNull(); // one at a time
  });

  it('a refusal stays in the panel; "already saved" closes it for good', () => {
    const s = startReveal(opened(), 1500)!;
    const refused = applyReveal(s.ui, s.ticket, { ok: false, error: 'not this page', refresh: false, saved: false, drop: false }, true, 1700);
    expect(refused).toMatchObject({ open: true, revealing: false, words: null, error: 'not this page', changedAt: 1700 });
    const saved = applyReveal(s.ui, s.ticket, { ok: false, error: 'saved', refresh: true, saved: true, drop: false }, true, 1700);
    expect(saved).toMatchObject({ open: false, savedFor: ADDR });
    expect(bankBackupView(LIVE, saved, 'app')!.state).toBe('done');
  });

  it('I SAVED needs a reveal; a failed save keeps the words, a 409 drops them', () => {
    expect(armSave(opened(), 1)).toEqual(opened());
    const saving = startSave(armSave(shown(), 3000));
    expect(saving).toMatchObject({ saving: true, armed: false });
    const failed = applySave(saving, { ok: false, error: 'could not record', refresh: false, saved: false, drop: false }, 4000);
    expect(failed).toMatchObject({ saving: false, words: WORDS, key: KEY, error: 'could not record' });
    const dropped = applySave(saving, { ok: false, error: 'tap SHOW again', refresh: true, saved: false, drop: true }, 4000);
    expect(dropped).toMatchObject({ saving: false, words: null, key: null, open: true, error: 'tap SHOW again' });
    expect(bankBackupView(LIVE, dropped, 'app')!.panel!.saved.disabled).toBe(true);
    const noted = applySave(saving, { ok: true, note: 'saved, but not confirmed on disk' }, 4000);
    expect(bankBackupView(LIVE, noted, 'app')).toMatchObject({ state: 'done', error: 'saved, but not confirmed on disk' });
    // A save that lands after the panel closed changes nothing on the page.
    const closed = closeBackupPanel(saving, 3500);
    expect(applySave(closed, { ok: true, note: null }, 4000)).toBe(closed);
    expect(startSave(shown())).toEqual(shown()); // not armed: nothing goes out
  });

  it('SHOW, HIDE, SHOW again: I SAVED waits for the reveal, and a 409 on a save never leaves SHOW stuck', () => {
    const ok: RevealResult = { ok: true, words: [...WORDS], key: KEY, address: ADDR };
    const showLabel = (ui: BankBackupUi) => bankBackupView(LIVE, ui, 'app')!.panel!.show;
    const hidden = hideWords(shown(), 3000);
    expect(hidden.key).toBe(KEY); // a key is kept: I SAVED is offered while masked
    const again = startReveal(hidden, 4000)!;
    // While the second reveal is out, I SAVED is really disabled and neither
    // its tap nor a ⚠ CONFIRM does anything.
    expect(bankBackupView(LIVE, again.ui, 'app')!.panel!.saved).toEqual({ act: 'arm', label: 'I SAVED', danger: false, busy: false, disabled: true });
    expect(armSave(again.ui, 4600)).toBe(again.ui);
    const armedAnyway = { ...again.ui, armed: true };
    expect(startSave(armedAnyway)).toBe(armedAnyway);
    // A save already out when that reveal went (the overlap this guards
    // against) answers 409 "not shown / key changed": the new generation
    // frees SHOW, and the late reveal is dropped by its old ticket.
    const overlap: BankBackupUi = { ...again.ui, saving: true };
    expect(showLabel(overlap)).toEqual({ act: 'show', label: 'SHOWING…', busy: true });
    const dropped = applySave(overlap, { ok: false, error: 'not shown; tap SHOW again', refresh: true, saved: false, drop: true }, 5000);
    expect(dropped).toMatchObject({ revealing: false, saving: false, words: null, key: null, open: true });
    const late = applyReveal(dropped, again.ticket, ok, true, 5100);
    expect(late).toBe(dropped);
    expect(showLabel(late)).toEqual({ act: 'show', label: 'SHOW', busy: false });
    // And SHOW works again from there.
    const third = startReveal(late, 5600)!;
    expect(applyReveal(third.ui, third.ticket, ok, true, 6000)).toMatchObject({ revealing: false, words: WORDS, key: KEY });
    // Without the overlap the second reveal simply lands, and I SAVED comes back.
    const landed = applyReveal(again.ui, again.ticket, ok, true, 4500);
    expect(bankBackupView(LIVE, landed, 'app')!.panel!.saved).toMatchObject({ label: 'I SAVED', disabled: false });
    expect(armSave(landed, 5000)).toMatchObject({ armed: true });
  });

  it('HIDE frees SHOW even with a reveal out, and drops that reveal', () => {
    const s = startReveal(opened(), 1500)!;
    const h = hideWords(s.ui, 1600);
    expect(h).toMatchObject({ revealing: false, words: null });
    expect(h.gen).toBeGreaterThan(s.ticket);
    expect(applyReveal(h, s.ticket, { ok: true, words: [...WORDS], key: KEY, address: ADDR }, true, 1700)).toBe(h);
    expect(bankBackupView(LIVE, h, 'app')!.panel!.show).toEqual({ act: 'show', label: 'SHOW', busy: false });
    expect(startReveal(h, 2200)).not.toBeNull();
  });

  it('SHOW waits while a save is out, and is free again once it answers', () => {
    const saving = startSave(armSave(shown(), 3000));
    expect(saving.saving).toBe(true);
    // The words still show during the save: HIDE is always offered.
    expect(bankBackupView(LIVE, saving, 'app')!.panel!.show).toEqual({ act: 'hide', label: 'HIDE', busy: false });
    const hidden = hideWords(saving, 3500);
    expect(hidden.saving).toBe(true);
    // Masked mid-save: SHOW stays put (busy, so it keeps focus) and a tap asks nothing.
    expect(bankBackupView(LIVE, hidden, 'app')!.panel!.show).toEqual({ act: 'show', label: 'SHOW', busy: true });
    expect(startReveal(hidden, 4000)).toBeNull();
    expect(startReveal(saving, 4000)).toBeNull();
    // A save that failed for another reason keeps the key: SHOW and I SAVED are both free.
    const failed = applySave(hidden, { ok: false, error: 'could not record', refresh: false, saved: false, drop: false }, 4500);
    expect(bankBackupView(LIVE, failed, 'app')!.panel!.show).toEqual({ act: 'show', label: 'SHOW', busy: false });
    expect(startReveal(failed, 5000)).not.toBeNull();
    const dropped = applySave(hidden, { ok: false, error: 'tap SHOW again', refresh: true, saved: false, drop: true }, 4500);
    expect(startReveal(dropped, 5000)).not.toBeNull();
  });

  it('opening the Bank starts from the nag, remembering only a clipboard that may hold the words', () => {
    const ui = { ...shown(), copy: 'stuck' as const, copiedAt: 2100, error: 'x', savedFor: ADDR };
    expect(resetBackupUi(ui)).toEqual({ ...BACKUP_IDLE, gen: ui.gen + 1, copy: 'stuck', copiedAt: 2100 });
    expect(resetBackupUi({ ...ui, copy: 'wiped' })).toMatchObject({ copy: 'none', copiedAt: 0 });
  });

  it('opens after TURN ON only for a wallet that just came on, from words not backed up, on a page that can show them', () => {
    const ready = node({ state: 'ready' });
    expect(opensAfterTurnOn(ready, LIVE, 'app')).toBe(true);
    expect(opensAfterTurnOn(null, LIVE, 'dev')).toBe(true);
    expect(opensAfterTurnOn(ready, LIVE, 'elsewhere')).toBe(false);
    expect(opensAfterTurnOn(LIVE, LIVE, 'app')).toBe(false); // KEEP IT ON: it was on already
    expect(opensAfterTurnOn(ready, node({ ...ON, backed_up: true }, ADDR), 'app')).toBe(false);
    expect(opensAfterTurnOn(ready, node({ state: 'on' }, ADDR), 'app')).toBe(false); // an older node
    expect(opensAfterTurnOn(ready, ready, 'app')).toBe(false); // the turn failed
  });
});

describe('the fresh-tap and held-key guards', () => {
  it('ignores a double-click\'s second click and a tap within 500 ms of a change', () => {
    expect(freshTap(1, 1500, 1000)).toBe(true);
    expect(freshTap(0, 1500, 1000)).toBe(true); // a keyboard click
    expect(freshTap(2, 5000, 1000)).toBe(false);
    expect(freshTap(1, 1499, 1000)).toBe(false);
  });

  it('stops a held Enter or Space on SHOW, I SAVED and the wallet switch', () => {
    for (const id of [BACKUP_SHOW_ID, BACKUP_SAVED_ID, BANK_WALLET_BUTTON_ID]) {
      expect(heldKeyRepeat({ repeat: true, key: 'Enter' }, id)).toBe(true);
      expect(heldKeyRepeat({ repeat: true, key: ' ' }, id)).toBe(true);
      expect(heldKeyRepeat({ repeat: false, key: 'Enter' }, id)).toBe(false);
      expect(heldKeyRepeat({ repeat: true, key: 'ArrowDown' }, id)).toBe(false);
    }
    expect(heldKeyRepeat({ repeat: true, key: 'Enter' }, 'bank-copy-address')).toBe(false);
    expect(heldKeyRepeat({ repeat: true, key: 'Enter' }, undefined)).toBe(false);
  });
});

const answer = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const ORIGIN = 'http://127.0.0.1:8081';
const good = { ok: true, words: WORDS, key: KEY, address: ADDR };
const revealWith = (res: Response) => revealWords(ORIGIN, ADDR, (async () => res) as unknown as typeof fetch);

describe('revealWords', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs a simple, uncached request to the node\'s own origin, refusing redirects', async () => {
    const fetchImpl = vi.fn(async () => answer(200, good));
    expect(await revealWords(ORIGIN, ADDR, fetchImpl as unknown as typeof fetch)).toEqual({ ok: true, words: WORDS, key: KEY, address: ADDR });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8081/api/chia/words');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it('reads 404 as an older node, and brings back the node\'s refusals trimmed', async () => {
    expect(await revealWith(new Response('', { status: 404 }))).toMatchObject({ ok: false, error: "your station node is older than the Bank's BACK UP: update Star Station" });
    const forbidden = await revealWith(answer(403, { ok: false, error: '  only the Star Station app on this computer can show the 24 words  ' }));
    expect(forbidden).toEqual({ ok: false, error: 'only the Star Station app on this computer can show the 24 words', refresh: false, saved: false, drop: false });
    const long = await revealWith(answer(500, { ok: false, error: 'x'.repeat(900) }));
    expect((long as { error: string }).error).toHaveLength(400);
    expect(await revealWith(answer(409, { ok: false, error: 'the wallet is turning' }))).toMatchObject({ ok: false, error: 'the wallet is turning', refresh: true, saved: false });
    expect(await revealWith(answer(409, { ok: false, saved: true, error: 'marked saved' }))).toMatchObject({ ok: false, saved: true, refresh: true });
    expect(await revealWith(answer(500, 'not json'))).toMatchObject({ ok: false, error: 'your station node answered 500, so the words are not shown' });
  });

  it('takes a 200 only whole: never some of the words', async () => {
    const malformed = [
      { ...good, words: WORDS.slice(0, 23) },
      { ...good, words: [...WORDS, 'zoo'] },
      { ...good, words: ['Abandon', ...WORDS.slice(1)] },
      { ...good, words: ['aband0n', ...WORDS.slice(1)] },
      { ...good, words: ['<b>', ...WORDS.slice(1)] },
      { ...good, words: ['two words', ...WORDS.slice(1)] },
      { ...good, words: ['abandonee', ...WORDS.slice(1)] }, // 9 letters
      { ...good, words: ['ab', ...WORDS.slice(1)] },
      { ...good, words: [7, ...WORDS.slice(1)] },
      { ...good, words: WORDS.join(' ') },
      { ...good, words: null },
      { ...good, key: -1 },
      { ...good, key: 1.5 },
      { ...good, key: 2 ** 32 },
      { ...good, key: '123' },
      { ...good, key: undefined },
      { ...good, address: 'xch1' + ADDR.slice(5) },
      { ...good, address: ADDR.slice(0, -1) },
      { ...good, address: null },
      { ...good, ok: 'yes' },
      null,
      [],
      'abandon',
    ];
    for (const body of malformed) {
      const r = await revealWith(answer(200, body ?? 'null'));
      expect(r).toEqual({ ok: false, error: "your station node's answer was not 24 words, so nothing is shown", refresh: false, saved: false, drop: false });
      expect(JSON.stringify(r)).not.toContain('accident');
    }
    expect(await revealWith(answer(200, { ...good, key: 0 }))).toMatchObject({ ok: true, key: 0 });
    expect(await revealWith(answer(200, { ...good, key: 2 ** 32 - 1 }))).toMatchObject({ ok: true, key: 2 ** 32 - 1 });
  });

  it('refuses words for another address than the one shown, and asks for the fingerprint again', async () => {
    const r = await revealWith(answer(200, { ...good, address: OTHER }));
    expect(r).toEqual({ ok: false, error: 'the wallet changed under the Bank, so these words are not shown; look again', refresh: true, saved: false, drop: false });
  });

  it('never throws: no origin, an unreachable node, or no answer in time', async () => {
    const never = vi.fn();
    expect(await revealWords('', ADDR, never as unknown as typeof fetch)).toMatchObject({ ok: false, error: 'your station node is not answering, so the words are not shown' });
    expect(never).not.toHaveBeenCalled();
    const unreachable = async () => { throw new TypeError('Failed to fetch'); };
    expect(await revealWords(ORIGIN, ADDR, unreachable as unknown as typeof fetch)).toMatchObject({ ok: false, error: 'your station node could not be reached, so the words are not shown' });
    vi.useFakeTimers();
    const hangs = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const pending = revealWords(ORIGIN, ADDR, hangs as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ ok: false, error: 'your station node did not answer in time, so the words are not shown; tap SHOW again' });
    // Headers in time, the body not: still a timeout.
    const trickles = async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    }) as unknown as Response;
    const slow = revealWords(ORIGIN, ADDR, trickles as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await slow as { error: string }).error).toContain('did not answer in time');
  });
});

describe('markWordsSaved', () => {
  const saveWith = (res: Response) => markWordsSaved(ORIGIN, 1234567890, (async () => res) as unknown as typeof fetch);

  it('POSTs the key fingerprint, and nothing else', async () => {
    const fetchImpl = vi.fn(async () => answer(200, { ok: true, wallet: { state: 'on', mnemonic: true, backed_up: true } }));
    expect(await markWordsSaved(ORIGIN, 1234567890, fetchImpl as unknown as typeof fetch)).toEqual({ ok: true, note: null });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8081/api/chia/words/saved?key=1234567890');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    expect(await saveWith(answer(200, { ok: true, note: ' saved, but not confirmed on disk ' }))).toEqual({ ok: true, note: 'saved, but not confirmed on disk' });
    expect(await saveWith(answer(409, { ok: false, saved: true, error: 'marked saved' }))).toEqual({ ok: true, note: null });
  });

  it('refuses a key that is not a u32 before anything is sent', async () => {
    const never = vi.fn();
    for (const key of [-1, 1.5, 2 ** 32, Number.NaN, '7' as unknown as number]) {
      expect(await markWordsSaved(ORIGIN, key, never as unknown as typeof fetch)).toMatchObject({ ok: false, drop: true });
    }
    expect(never).not.toHaveBeenCalled();
  });

  it('passes the node\'s 409 through and drops the words; anything else keeps them for another try', async () => {
    expect(await saveWith(answer(409, { ok: false, error: 'the wallet changed since these words were shown; tap SHOW again' })))
      .toEqual({ ok: false, error: 'the wallet changed since these words were shown; tap SHOW again', refresh: true, saved: false, drop: true });
    expect(await saveWith(answer(500, { ok: false, error: 'the Bank could not record it (disk full); your words are fine, tap I SAVED again' })))
      .toMatchObject({ ok: false, error: 'the Bank could not record it (disk full); your words are fine, tap I SAVED again', drop: false });
    expect(await saveWith(answer(502, 'gateway'))).toMatchObject({
      ok: false, error: 'the Bank could not record it: your station node answered 502. Your words are fine; tap I SAVED again', drop: false,
    });
    expect(await saveWith(new Response('', { status: 404 }))).toMatchObject({ ok: false, error: "your station node is older than the Bank's BACK UP: update Star Station" });
    const unreachable = async () => { throw new TypeError('Failed to fetch'); };
    expect(await markWordsSaved(ORIGIN, 7, unreachable as unknown as typeof fetch)).toMatchObject({
      ok: false, error: 'the Bank could not record it: your station node could not be reached. Your words are fine; tap I SAVED again', drop: false,
    });
    const hangs = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const late = await markWordsSaved(ORIGIN, 7, hangs as unknown as typeof fetch, 20);
    expect(late).toMatchObject({ ok: false, refresh: true, drop: false });
    expect((late as { error: string }).error).toContain('did not answer in time');
    expect(await markWordsSaved('', 7, vi.fn() as unknown as typeof fetch)).toMatchObject({ ok: false, drop: false });
  });
});

describe('the clipboard', () => {
  const clip = (fails = false) => {
    const writes: string[] = [];
    return { writes, writeText: vi.fn(async (t: string) => { if (fails) throw new DOMException('denied', 'NotAllowedError'); writes.push(t); }) };
  };

  it('COPY writes exactly the 24 words, space-separated, nothing more', async () => {
    const c = clip();
    expect(await copyWords(WORDS, c)).toBe('held');
    expect(c.writes).toEqual([WORDS.join(' ')]);
    expect(c.writes[0]).not.toMatch(/\d|\n/);
    expect(await copyWords(WORDS, clip(true))).toBe('refused');
    expect(await copyWords(WORDS, undefined)).toBe('refused');
    const none = clip();
    expect(await copyWords(null, none)).toBe('refused');
    expect(await copyWords(WORDS.slice(1), none)).toBe('refused');
    expect(none.writeText).not.toHaveBeenCalled();
  });

  it('empties the clipboard only from held', async () => {
    const c = clip();
    expect(await wipeClipboard('held', c)).toBe('wiped');
    expect(c.writes).toEqual(['']);
    expect(await wipeClipboard('held', clip(true))).toBe('stuck');
    expect(await wipeClipboard('held', undefined)).toBe('stuck');
    const idle = clip();
    for (const copy of ['none', 'wiped', 'stuck', 'refused'] as const) expect(await wipeClipboard(copy, idle)).toBe(copy);
    expect(idle.writeText).not.toHaveBeenCalled();
  });

  it('a panel tap tries again after a refused wipe; the timer and a hidden page do not', async () => {
    expect(wipeWanted('held', false)).toBe(true);
    expect(wipeWanted('stuck', false)).toBe(false);
    expect(wipeWanted('stuck', true)).toBe(true);
    for (const copy of ['none', 'wiped', 'refused'] as const) expect(wipeWanted(copy, true)).toBe(false);
    const c = clip();
    expect(await wipeClipboard('stuck', c)).toBe('stuck');
    expect(c.writeText).not.toHaveBeenCalled();
    expect(await wipeClipboard('stuck', c, true)).toBe('wiped');
    expect(c.writes).toEqual(['']);
    expect(await wipeClipboard('stuck', clip(true), true)).toBe('stuck');
    const idle = clip();
    for (const copy of ['none', 'wiped', 'refused'] as const) expect(await wipeClipboard(copy, idle, true)).toBe(copy);
    expect(idle.writeText).not.toHaveBeenCalled();
    // The tap's wipe lands on the copy it was started for, and not after a
    // newer COPY or the address's COPY.
    const stuck = afterWipe(afterCopy(shown(), 'held', 10_000), 10_000, 'stuck');
    expect(stuck).toMatchObject({ copy: 'stuck', copiedAt: 10_000 });
    expect(afterWipe(stuck, 10_000, 'wiped').copy).toBe('wiped');
    expect(afterWipe(stuck, 10_000, 'stuck')).toMatchObject({ copy: 'stuck' });
    expect(afterWipe(afterCopy(stuck, 'held', 20_000), 10_000, 'wiped').copy).toBe('held');
    expect(afterWipe(afterAddressCopy(stuck), 10_000, 'wiped').copy).toBe('none');
  });

  it('is due for a wipe at 60 s; the address\'s COPY cancels it, and a newer copy outlives an older wipe', () => {
    const held = afterCopy(shown(), 'held', 10_000);
    expect(held).toMatchObject({ copy: 'held', copiedAt: 10_000 });
    expect(clipboardWipeDue(held, 10_000 + CLIPBOARD_WIPE_MS - 1)).toBe(false);
    expect(clipboardWipeDue(held, 10_000 + CLIPBOARD_WIPE_MS)).toBe(true);
    const address = afterAddressCopy(held);
    expect(address.copy).toBe('none');
    expect(clipboardWipeDue(address, 10_000 + CLIPBOARD_WIPE_MS)).toBe(false);
    expect(afterAddressCopy(address)).toBe(address);
    expect(afterWipe(held, 10_000, 'wiped').copy).toBe('wiped');
    expect(afterWipe(afterCopy(held, 'held', 20_000), 10_000, 'stuck').copy).toBe('held');
    expect(afterWipe(address, 10_000, 'wiped')).toBe(address);
    expect(afterCopy(shown(), 'refused', 10_000)).toMatchObject({ copy: 'refused', copiedAt: 0 });
  });
});

describe('backupGridHtml', () => {
  it('masked, holds none of the words, and 24 numbered cells of the same mask', () => {
    const html = backupGridHtml(null);
    for (const w of WORDS) expect(has(html, w)).toBe(false);
    for (let n = 1; n <= 24; n++) expect(html).toContain(`aria-label="word ${n}, hidden"`);
    expect(html.match(/••••••/g)).toHaveLength(24);
    expect(html).toContain(`id="${BACKUP_GRID_ID}"`);
    expect(html).not.toMatch(/text-security|data-|title=/);
    // A words list of any other length is not shown either.
    expect(backupGridHtml(WORDS.slice(0, 23))).toBe(html);
  });

  it('shown, holds each word once as text, in order, never in an attribute, and cannot be selected', () => {
    const html = backupGridHtml(WORDS);
    const attrs = [...html.matchAll(/\s[\w-]+="([^"]*)"/g)].map((m) => m[1]).join(' ');
    for (const w of WORDS) expect(has(attrs, w)).toBe(false);
    const text = html.replace(/<[^>]*>/g, ' ');
    let at = 0;
    WORDS.forEach((w, i) => {
      const cell = new RegExp(`\\b${i + 1}\\s+${w}\\b`);
      expect(text.slice(at)).toMatch(cell);
      at += text.slice(at).search(cell) + 1;
    });
    expect(html).toContain('user-select:none');
    expect(html).toContain('-webkit-user-select:none');
    expect(html).not.toContain('aria-live');
    expect(html).not.toContain('••••••');
  });

  it('escapes what it is given, though the reveal only lets a–z through', () => {
    const odd = [...WORDS.slice(0, 23), '<img src=x>'];
    expect(backupGridHtml(odd)).not.toContain('<img');
  });
});
