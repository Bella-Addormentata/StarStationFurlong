// 🏦 BACK UP: the SSF wallet's 24 words in the SpacePhone's Bank.
//
// The node's SSF wallet is made from 24 BIP39 words (Chia's derivation, so
// Sage or the Chia wallet set to testnet11 opens the same wallet). The node
// keeps them in its folder and never prints them; the Bank shows them once,
// on request, for the player to write on paper, and "I SAVED" tells the node
// to stop asking. After that the page never shows them again.
//
// This module is the Bank's part, kept out of main.ts so it is tested: what
// RECEIVE shows (the nag, the panel with its masked grid, the done line), how
// the page's own state follows the node's fingerprint and the screen, the two
// requests to the node, the clipboard, and the grid's markup.
//
// Where the words live on the page: only in `BankBackupUi.words`, from a
// reveal that passed every check here until the first of HIDE, LATER, a save,
// five minutes, the Bank leaving the screen (phone put away, another view,
// the page hidden), or a fingerprint that no longer matches the wallet they
// were shown for. JavaScript cannot zero a string, so dropping every
// reference is the most the page can do; each panel opening (and each wipe)
// gets a new generation, and a reveal that answers for an older one is
// dropped, so a late answer never puts the words back.
//
// Known and accepted for testnet (a native reveal in the desktop host is the
// mainnet fix for both): any script in the game page can ask for the words
// while they are not marked saved, and another OS account's page on this
// computer reaches the same loopback node. So the page's BACK UP is offered
// only on a test network (`ChiaNetwork.test`), and on any other network the
// two requests are refused here before anything is sent.
//
// 🖥️ The native BACK UP: when the node says the desktop app's channel is on
// (`chia_wallet.backup` is `native`) and the page runs inside the app
// (nativeShell.ts `hasNativeShell`), BACK UP is one button, OPEN BACKUP
// WINDOW. The app shows the words in a window of its own; the page never
// asks the node for them, never marks them saved, and never holds one. That
// works on any network the page knows. On a network that is not a test one,
// with no native BACK UP, the Bank says to back up from the desktop app.

import { BANK_WALLET_BUTTON_ID } from './bankWallet';
import { isAddressOn, type ChiaNetwork } from './chiaNetwork';
import type { NativeBackupAnswer } from './nativeShell';
import type { LocalFingerprint } from './nodeFingerprint';

/** Control ids: stable across renders, so focus survives a repaint. SHOW
 *  turns into HIDE and I SAVED into ⚠ CONFIRM on the same control. */
export const BACKUP_ID = 'bank-backup';
export const BACKUP_SHOW_ID = 'bank-backup-show';
export const BACKUP_COPY_ID = 'bank-backup-copy';
export const BACKUP_SAVED_ID = 'bank-backup-saved';
export const BACKUP_LATER_ID = 'bank-backup-later';
export const BACKUP_GRID_ID = 'bank-backup-grid';
/** 🖥️ OPEN BACKUP WINDOW, the native BACK UP's one control. */
export const BACKUP_WINDOW_ID = 'bank-backup-window';

export const WORD_COUNT = 24;
export const REVEAL_TIMEOUT_MS = 15_000;
export const SAVE_TIMEOUT_MS = 15_000;
/** The words hide themselves this long after a reveal. */
export const WORDS_SHOWN_MS = 300_000;
/** COPY's clipboard is emptied (best effort) this long after the copy. */
export const CLIPBOARD_WIPE_MS = 60_000;
/** A tap this soon after a control changed what it does is the second half
 *  of a double-click or a held Enter, not a decision. */
export const BANK_SETTLE_MS = 500;

// ── Where the page runs ──────────────────────────────────────────────────────

/** `app`: the Star Station desktop app's own page, the one page the node
 *  shows the words to. `dev`: a loopback http page, which the node shows
 *  them to only when its origin is listed in `SSF_BANK_DEV_PAGES` (its 403
 *  says so). `elsewhere`: any other page, which is told to open the app. */
export type BackupPage = 'app' | 'dev' | 'elsewhere';

export function backupPageKind(loc: { protocol: string; hostname: string }): BackupPage {
  const host = loc.hostname.toLowerCase();
  const web = loc.protocol === 'http:' || loc.protocol === 'https:';
  if (loc.protocol === 'tauri:' || (web && host === 'tauri.localhost')) return 'app';
  if (web && (host === 'localhost' || host === '[::1]' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host))) return 'dev';
  return 'elsewhere';
}

// ── The page's state ─────────────────────────────────────────────────────────

/** COPY's clipboard: never copied (or overwritten by the address's COPY),
 *  holding the words, emptied, not emptied when it should have been, or a
 *  write the page was refused. */
export type BackupCopy = 'none' | 'held' | 'wiped' | 'stuck' | 'refused';

export interface BankBackupUi {
  /** The panel is open (it replaces the QR, the address and the balance). */
  open: boolean;
  /** Bumped at every opening, closing and wipe: a reveal applies only to
   *  the generation it was asked in. */
  gen: number;
  revealing: boolean;
  /** The words, only while shown. */
  words: readonly string[] | null;
  /** The key fingerprint of the last reveal in this opening: what I SAVED
   *  records. Kept while the words are hidden; not a secret. */
  key: number | null;
  /** The address the panel was opened for: a reveal must answer for it. */
  address: string | null;
  /** When the words were shown, on the monotonic clock (`performance.now`)
   *  and on the wall clock (`Date.now`). They hide at the earlier of the two
   *  deadlines: the monotonic clock can stop through an OS sleep (words left
   *  showing before an hour's sleep would still read as a minute old), and
   *  the wall clock can be set back; neither can keep them up past five
   *  minutes of the other. */
  shownAt: number;
  shownWall: number;
  /** The words hid themselves after WORDS_SHOWN_MS. */
  expired: boolean;
  /** I SAVED became ⚠ CONFIRM. */
  armed: boolean;
  saving: boolean;
  /** The save out, by a number from the generation sequence (which never
   *  repeats, even across a reset): its answer lands only while it is this
   *  one. HIDE, a hidden page and the expiry keep it; closing drops it. */
  saveTicket: number | null;
  /** The address whose words this page recorded as saved, until the node's
   *  fingerprint says so too. */
  savedFor: string | null;
  copy: BackupCopy;
  copiedAt: number;
  error: string | null;
  /** When a control last changed what it does: the fresh-tap rule's clock. */
  changedAt: number;
  /** 🖥️ OPEN BACKUP WINDOW is out: the desktop app's window is open, and a
   *  second tap does nothing until it answers. Kept through every reset and
   *  close, so one call is out at a time whatever the Bank does meanwhile. */
  windowOpen: boolean;
  /** 🖥️ What the last OPEN BACKUP WINDOW came back with, as a line; until
   *  the next tap, the Bank opening again, the wallet going (another
   *  address, not on, backed up, no node), or BACK UP no longer native. */
  windowLine: string | null;
  /** 🖥️ The address OPEN BACKUP WINDOW was tapped for: its line is shown
   *  only while the Bank's wallet is still this one. */
  windowFor: string | null;
}

export const BACKUP_IDLE: Readonly<BankBackupUi> = {
  open: false,
  gen: 0,
  revealing: false,
  words: null,
  key: null,
  address: null,
  shownAt: 0,
  shownWall: 0,
  expired: false,
  armed: false,
  saving: false,
  saveTicket: null,
  savedFor: null,
  copy: 'none',
  copiedAt: 0,
  error: null,
  changedAt: 0,
  windowOpen: false,
  windowLine: null,
  windowFor: null,
};

/** Everything a closed panel forgets. */
const CLOSED = {
  open: false,
  revealing: false,
  words: null,
  key: null,
  address: null,
  shownAt: 0,
  shownWall: 0,
  expired: false,
  armed: false,
  saving: false,
  saveTicket: null,
  error: null,
} as const;

/** 🖥️ Which BACK UP the Bank offers. `native`: the node says the desktop
 *  app's channel is on and the page runs in the app (`shell`, from
 *  nativeShell.ts `hasNativeShell`), so the app's window shows the words.
 *  `page`: this page's reveal, on a test network (a `backup` of `page`,
 *  `none`, an unknown one or none at all, or `native` with no app to ask).
 *  `desktop`: any other network, where this page shows no words and says to
 *  back up from the desktop app. */
export type BackupMode = 'native' | 'page' | 'desktop';

export function backupMode(fp: LocalFingerprint | null | undefined, shell: boolean): BackupMode {
  if (shell && fp?.chia_wallet?.backup === 'native') return 'native';
  return fp?.chia_net?.test ? 'page' : 'desktop';
}

/** An on wallet made from 24 words (an older node never says `mnemonic`),
 *  with an address on its network, which the page knows. */
function walletAddress(fp: LocalFingerprint | null | undefined): string | null {
  const w = fp?.chia_wallet;
  if (!fp || !w || w.state !== 'on' || w.mnemonic !== true || !isAddressOn(fp.chia_net, fp.chia_address)) return null;
  return fp.chia_address;
}

/** The address BACK UP is for: the wallet's ([`walletAddress`]) in the
 *  native mode, on any network the page knows, or on a test network in the
 *  page mode. Null otherwise: off a test network only the desktop app shows
 *  the words, never this page. */
function backupAddress(fp: LocalFingerprint | null | undefined, mode: BackupMode): string | null {
  return mode === 'desktop' ? null : walletAddress(fp);
}

const backedUp = (fp: LocalFingerprint | null | undefined): boolean => fp?.chia_wallet?.backed_up === true;

// ── The words the Bank says ──────────────────────────────────────────────────

export const BACKUP_NAG =
  "⚠ Your SSF wallet's 24 words are not backed up. Without them, this wallet and its coins stay on this computer only: no other Chia wallet can open it.";
export const BACKUP_ELSEWHERE = 'Open the Star Station app on this computer to back up the 24 words.';
/** 🖥️ Instead of BACK UP off a test network, with no native BACK UP. */
export const BACKUP_DESKTOP = 'Back up from the Star Station desktop app on this computer.';
/** 🖥️ The native BACK UP's one control. */
export const BACKUP_WINDOW_LABEL = 'OPEN BACKUP WINDOW';
/** 🖥️ What each answer of the desktop app's backup window says. */
export const BACKUP_WINDOW_LINES: Readonly<Record<NativeBackupAnswer, string>> = Object.freeze({
  saved: 'Saved: your node has your 24 words marked as written down.',
  closed: 'The backup window closed before CONFIRM, so your 24 words are not marked saved yet.',
  no_channel: 'The desktop app did not start this station node, so it cannot show the 24 words. Stop the other station node and restart Star Station.',
  other_network: 'Your station node runs on another Chia network than this app, so the app does not show its 24 words.',
  not_on: 'Your SSF wallet is not on, so there are no 24 words to show.',
  turning: 'Your SSF wallet is still turning on. Try again in a moment.',
  already_saved: 'Your 24 words are already marked saved, so they are not shown again.',
  busy: 'The backup window is open, or just closed. Try again in a few seconds.',
  unavailable: 'The desktop app could not open the backup window. Restart Star Station, or update it.',
});
export const BACKUP_DONE =
  'Your 24 words are backed up. The Bank does not show them again: keep the paper safe, it is the only copy away from this computer.';
export const BACKUP_TITLE = 'BACK UP — YOUR 24 WORDS';
export const BACKUP_WARNING =
  'These 24 words are this SSF wallet. Anyone who reads them can take its coins; with them, Sage or the Chia wallet (set to testnet11) brings it back on any computer. Write them on paper, in order — not a screenshot, not a chat, not a file on this computer. Tap SHOW only when nobody can see your screen or your stream.';
export const backupKeyLine = (key: number): string =>
  `Key fingerprint ${key} — Sage and the Chia wallet show this number for these words. Open them there to recover or to look, not to spend while your node's wallet is on: a spend there can take the coin your node writes with.`;
export const BACKUP_FUNDING =
  'Fund your node only at the address shown here. Sage and the Chia wallet show other addresses of the same words, which your node does not watch.';
export const BACKUP_ARMED = 'Written all 24, in order? The Bank stops asking and will not show them again. Tap CONFIRM.';
export const BACKUP_EXPIRED = 'Hidden after 5 minutes. Tap SHOW to see them again.';
/** 🔒 How the wallet's file keeps its key on disk, under BACK UP's line. */
export const AT_REST_DPAPI =
  'On disk, its key is locked to your Windows account on this PC. Reinstalling Windows, an administrator resetting your password, or another PC loses that copy: the 24 words you saved are the backup.';
export const AT_REST_UNTIL_SAVED =
  'On disk, its key is in the clear in chia_identity.json until you save the 24 words; then your node locks the file to your Windows account.';
export const AT_REST_RETRY =
  'On disk, its key is still in the clear in chia_identity.json: your node locks the file to your Windows account at its next start.';
export const AT_REST_CLEAR =
  'On disk, its key is in the clear in chia_identity.json: anyone who can read that file has this wallet.';
export const AT_REST_REWRAPPED =
  'Copies of your node\'s folder made before it locked this file (a synced or zipped folder, a backup) still hold the key in the clear: delete them.';

/** The at-rest lines for an on 24-word wallet, from what its node says;
 *  none from an older node, which does not say. */
export function atRestLines(fp: LocalFingerprint | null | undefined): string[] {
  const w = fp?.chia_wallet;
  if (!w || w.state !== 'on' || w.mnemonic !== true || w.at_rest === undefined) return [];
  const lines: string[] = [];
  if (w.at_rest === 'dpapi') lines.push(AT_REST_DPAPI);
  else if (w.at_rest_next === 'dpapi') lines.push(w.backed_up === true ? AT_REST_RETRY : AT_REST_UNTIL_SAVED);
  else lines.push(AT_REST_CLEAR);
  if (w.rewrapped === true) lines.push(AT_REST_REWRAPPED);
  return lines;
}

const COPY_NOTICE: Record<Exclude<BackupCopy, 'none'>, string> = {
  held:
    'COPIED. The Bank empties the clipboard when you tap HIDE, I SAVED or LATER. After 60 s, or when you put the phone away, it tries to, but the page may not be allowed to then. Clipboard history (Win+V, clipboard apps) and cloud clipboard sync can keep a copy of their own: paper is safer.',
  wiped: 'The Bank emptied the clipboard. Clipboard history (Win+V, clipboard apps) or cloud clipboard sync may still keep a copy.',
  stuck: 'The Bank could not empty the clipboard: it may still hold the 24 words. Copy something else over them.',
  refused: 'This page may not write the clipboard: write the words from the grid.',
};

// ── What RECEIVE shows ───────────────────────────────────────────────────────

export interface BackupPanelView {
  title: string;
  warning: string;
  /** The words for the grid, or null for the masked grid. */
  words: readonly string[] | null;
  /** SHOW, SHOWING… (busy) or HIDE, on one control. SHOW waits (busy,
   *  so it keeps focus) while a save is out: one request at a time. */
  show: { act: 'show' | 'hide'; label: string; busy: boolean };
  /** COPY is offered while the words show. */
  copy: boolean;
  /** I SAVED (really disabled until a reveal in this opening, and while a
   *  reveal is out), ⚠ CONFIRM (danger), or SAVING… (busy), on one control. */
  saved: { act: 'arm' | 'confirm'; label: string; danger: boolean; busy: boolean; disabled: boolean };
  keyLine: string | null;
  /** The funding line and the one address the node watches. */
  funding: { text: string; address: string } | null;
  armedWarning: string | null;
  expired: string | null;
}

export interface BankBackupView {
  /** `notice`: no wallet to back up, but the clipboard notice still holds. */
  state: 'nag' | 'panel' | 'done' | 'notice';
  /** The nag or the done line; none while the panel is open. */
  line: string | null;
  /** BACK UP is offered (the nag, on a page the node may show the words to). */
  open: boolean;
  /** Instead of BACK UP on any other page, or off a test network with no
   *  native BACK UP. */
  elsewhere: string | null;
  /** 🖥️ OPEN BACKUP WINDOW, in place of BACK UP, in the native mode: `busy`
   *  while the window is out. Never with the panel, a word or COPY. */
  window: { label: string; busy: boolean } | null;
  /** 🖥️ What the last OPEN BACKUP WINDOW came back with. */
  windowLine: string | null;
  panel: BackupPanelView | null;
  copyNotice: string | null;
  error: string | null;
  /** 🔒 How the file keeps its key on disk ([`atRestLines`]); shown with
   *  the nag or the done line, not in the panel. */
  atRest: string[];
}

/** What RECEIVE shows about the 24 words, or null when there is nothing to
 *  back up (no node, an older node, a wallet that is not on, one not made
 *  from words, or an address that did not read as one of its network's)
 *  and no clipboard notice still stands. `shell`: the page runs inside the
 *  desktop app ([`backupMode`]). */
export function bankBackupView(
  fp: LocalFingerprint | null | undefined,
  ui: BankBackupUi,
  page: BackupPage,
  shell = false,
): BankBackupView | null {
  const mode = backupMode(fp, shell);
  const address = backupAddress(fp, mode);
  // Outside the panel only what still matters there: a clipboard that may
  // hold the words, or that was emptied. That stays said with no wallet to
  // back up too (the node stopped or went away after a COPY).
  const outside = ui.copy === 'stuck' || ui.copy === 'wiped' ? COPY_NOTICE[ui.copy] : null;
  const none = { window: null, windowLine: null } as const;
  if (!address) {
    // Off a test network with no native BACK UP: the nag, and where to back
    // up instead; no control that asks anyone for the words.
    const desk = mode === 'desktop' ? walletAddress(fp) : null;
    if (desk) {
      const atRest = atRestLines(fp);
      if (backedUp(fp)) return { state: 'done', line: BACKUP_DONE, open: false, elsewhere: null, panel: null, copyNotice: outside, error: null, atRest, ...none };
      return { state: 'nag', line: BACKUP_NAG, open: false, elsewhere: BACKUP_DESKTOP, panel: null, copyNotice: outside, error: null, atRest, ...none };
    }
    return outside ? { state: 'notice', line: null, open: false, elsewhere: null, panel: null, copyNotice: outside, error: null, atRest: [], ...none } : null;
  }
  const atRest = atRestLines(fp);
  if (backedUp(fp) || ui.savedFor === address) {
    return { state: 'done', line: BACKUP_DONE, open: false, elsewhere: null, panel: null, copyNotice: outside, error: ui.error, atRest, ...none };
  }
  if (mode === 'native') {
    return {
      state: 'nag',
      line: BACKUP_NAG,
      open: false,
      elsewhere: null,
      window: { label: BACKUP_WINDOW_LABEL, busy: ui.windowOpen },
      windowLine: ui.windowLine,
      panel: null,
      copyNotice: outside,
      error: null,
      atRest,
    };
  }
  if (page === 'elsewhere') {
    return { state: 'nag', line: BACKUP_NAG, open: false, elsewhere: BACKUP_ELSEWHERE, panel: null, copyNotice: null, error: null, atRest, ...none };
  }
  if (!ui.open || ui.address !== address) {
    return { state: 'nag', line: BACKUP_NAG, open: true, elsewhere: null, panel: null, copyNotice: outside, error: ui.error, atRest, ...none };
  }
  const shown = ui.words !== null && ui.words.length === WORD_COUNT;
  const revealed = ui.key !== null;
  return {
    state: 'panel',
    line: null,
    open: false,
    elsewhere: null,
    ...none,
    panel: {
      title: BACKUP_TITLE,
      warning: BACKUP_WARNING,
      words: shown ? ui.words : null,
      show: ui.revealing
        ? { act: 'show', label: 'SHOWING…', busy: true }
        : shown
          ? { act: 'hide', label: 'HIDE', busy: false }
          : { act: 'show', label: 'SHOW', busy: ui.saving },
      copy: shown,
      saved: ui.saving
        ? { act: 'confirm', label: 'SAVING…', danger: false, busy: true, disabled: false }
        : ui.armed
          ? { act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false, disabled: false }
          : { act: 'arm', label: 'I SAVED', danger: false, busy: false, disabled: !revealed || ui.revealing },
      keyLine: revealed ? backupKeyLine(ui.key as number) : null,
      funding: revealed ? { text: BACKUP_FUNDING, address } : null,
      armedWarning: ui.armed && !ui.saving ? BACKUP_ARMED : null,
      expired: ui.expired && !shown ? BACKUP_EXPIRED : null,
    },
    copyNotice: ui.copy === 'none' ? null : COPY_NOTICE[ui.copy],
    error: ui.error,
    atRest: [],
  };
}

/** Whether TURN ON should open BACK UP (the panel, or in the native mode
 *  the desktop app's window): the wallet was not on, now is, is made from
 *  words that are not backed up, and this page may show them, or the app's
 *  window may, on any network the page knows. */
export function opensAfterTurnOn(
  before: LocalFingerprint | null | undefined,
  after: LocalFingerprint | null | undefined,
  page: BackupPage,
  shell = false,
): boolean {
  const mode = backupMode(after, shell);
  if ((mode !== 'native' && page === 'elsewhere') || before?.chia_wallet?.state === 'on') return false;
  return backupAddress(after, mode) !== null && !backedUp(after);
}

// ── How the state moves ──────────────────────────────────────────────────────
// Each returns the state it was given when nothing changes, so a caller can
// tell a change by identity.

/** Run before every render and at every fingerprint round, with the live
 *  fingerprint (null while the node is away) and whether the Bank is on
 *  screen. Drops the words (and a reveal in flight) when the Bank is not on
 *  screen; hides them after WORDS_SHOWN_MS on either clock (`now`
 *  monotonic, `wall` the wall clock); closes the panel, forgetting the
 *  key too, when the wallet it was opened for is gone: another address, not
 *  on, not from words, backed up, or no node, and when BACK UP turned native
 *  (`shell`, [`backupMode`]). The native answer's line goes with the wallet
 *  it was tapped for too, and when BACK UP stops being native. A change
 *  in anything else the fingerprint carries changes nothing here. */
export function reconcileBackupUi(
  ui: BankBackupUi,
  fp: LocalFingerprint | null | undefined,
  now: number,
  onScreen: boolean,
  wall: number = Date.now(),
  shell = false,
): BankBackupUi {
  let u = ui;
  const mode = backupMode(fp, shell);
  const address = backupAddress(fp, mode);
  const gone = !address || backedUp(fp) || (u.address !== null && u.address !== address);
  if ((gone || mode === 'native') && (u.open || u.words !== null || u.key !== null || u.revealing || u.armed || u.saving || u.address !== null || u.expired)) {
    u = { ...u, ...CLOSED, gen: u.gen + 1 };
  }
  // The answer's line is for the wallet it was tapped for, in the native
  // mode only: another wallet, or the page's own BACK UP, never shows it.
  if (u.windowLine !== null && (gone || mode !== 'native' || u.windowFor !== address)) u = { ...u, windowLine: null, windowFor: null };
  // The page's own "saved" stands in only until the node says so, and only
  // for the wallet it was said for.
  if (u.savedFor !== null && (backedUp(fp) || u.savedFor !== address)) u = { ...u, savedFor: null };
  if (!onScreen && (u.words !== null || u.revealing || u.armed)) {
    u = { ...u, words: null, revealing: false, armed: false, gen: u.gen + 1 };
  }
  if (u.words !== null && (now - u.shownAt >= WORDS_SHOWN_MS || wall - u.shownWall >= WORDS_SHOWN_MS)) {
    u = { ...u, words: null, revealing: false, expired: true, changedAt: now, gen: u.gen + 1 };
  }
  return u;
}

/** BACK UP, or TURN ON that made words: the panel opens masked. Only in
 *  the page mode: never in the native one (`shell`, [`backupMode`]). */
export function openBackupPanel(ui: BankBackupUi, fp: LocalFingerprint | null | undefined, now: number, shell = false): BankBackupUi {
  const mode = backupMode(fp, shell);
  const address = mode === 'page' ? backupAddress(fp, mode) : null;
  if (!address || backedUp(fp)) return ui;
  return { ...ui, ...CLOSED, open: true, address, gen: ui.gen + 1, changedAt: now };
}

/** LATER: the panel closes and forgets the words and the key. */
export function closeBackupPanel(ui: BankBackupUi, now: number): BankBackupUi {
  return { ...ui, ...CLOSED, gen: ui.gen + 1, changedAt: now };
}

/** Opening the Bank starts from the nag. Only a clipboard that may still
 *  hold the words is remembered, and an OPEN BACKUP WINDOW still out (its
 *  window is still open, so a tap must not ask for another), with the
 *  address it was tapped for, so its answer still shows. */
export function resetBackupUi(ui: BankBackupUi): BankBackupUi {
  const keep = ui.copy === 'held' || ui.copy === 'stuck';
  return {
    ...BACKUP_IDLE,
    gen: ui.gen + 1,
    copy: keep ? ui.copy : 'none',
    copiedAt: keep ? ui.copiedAt : 0,
    windowOpen: ui.windowOpen,
    windowFor: ui.windowOpen ? ui.windowFor : null,
  };
}

/** HIDE: the grid masks again; I SAVED stays offered (the key is kept). A
 *  new generation drops any reveal still out, so SHOW is free again. */
export function hideWords(ui: BankBackupUi, now: number): BankBackupUi {
  return { ...ui, words: null, revealing: false, expired: false, armed: false, changedAt: now, gen: ui.gen + 1 };
}

/** SHOW: the request's ticket is the generation it must still find. Not
 *  while another reveal or a save is out: one request at a time, so a
 *  save's answer never moves the generation under a reveal. */
export function startReveal(ui: BankBackupUi, now: number): { ui: BankBackupUi; ticket: number } | null {
  if (!ui.open || ui.revealing || ui.saving || !ui.address) return null;
  const gen = ui.gen + 1;
  return { ui: { ...ui, gen, revealing: true, words: null, expired: false, armed: false, error: null, changedAt: now }, ticket: gen };
}

/** The node's answer to SHOW, applied only to the generation it was asked
 *  in and only while the Bank is on screen; otherwise it is dropped. `now`
 *  is the monotonic clock, `wall` the wall clock ([`reconcileBackupUi`]). */
export function applyReveal(
  ui: BankBackupUi,
  ticket: number,
  r: RevealResult,
  onScreen: boolean,
  now: number,
  wall: number = Date.now(),
): BankBackupUi {
  if (ui.gen !== ticket || !ui.revealing) return ui;
  if (!onScreen) return { ...ui, revealing: false, gen: ui.gen + 1 };
  if (r.ok) return { ...ui, revealing: false, words: r.words, key: r.key, shownAt: now, shownWall: wall, expired: false, error: null, changedAt: now };
  // The node has them marked saved already: nothing to show, ever.
  if (r.saved) return { ...ui, ...CLOSED, gen: ui.gen + 1, savedFor: ui.address, changedAt: now };
  return { ...ui, revealing: false, error: r.error, changedAt: now };
}

/** I SAVED: arms ⚠ CONFIRM, once a reveal in this opening gave the key,
 *  and not while a reveal is out (its answer may change the key). */
export function armSave(ui: BankBackupUi, now: number): BankBackupUi {
  if (!ui.open || ui.key === null || ui.armed || ui.saving || ui.revealing) return ui;
  return { ...ui, armed: true, error: null, changedAt: now };
}

/** ⚠ CONFIRM: the request goes out with a ticket of its own; the words
 *  stay shown until it lands. Not while a reveal is out (so the generation
 *  it takes its ticket from moves under no reveal). */
export function startSave(ui: BankBackupUi): BankBackupUi {
  if (!ui.open || !ui.armed || ui.saving || ui.revealing || ui.key === null) return ui;
  const gen = ui.gen + 1;
  return { ...ui, gen, armed: false, saving: true, saveTicket: gen, error: null };
}

/** The node's answer to I SAVED. Saved: the panel closes for good. Refused
 *  for this key (409): the words and the key go, SHOW again (a new
 *  generation, which drops any reveal still out, so SHOW is free). Anything
 *  else: the words stay, and I SAVED can be tapped again. */
export function applySave(ui: BankBackupUi, ticket: number | null, r: SaveResult, now: number): BankBackupUi {
  // An answer for a save the panel dropped (LATER, the Bank reopened, another
  // wallet) is not this save's, even when a newer save is out.
  if (!ui.saving || ticket === null || ui.saveTicket !== ticket) return ui;
  if (r.ok) return { ...ui, ...CLOSED, gen: ui.gen + 1, savedFor: ui.address, error: r.note, changedAt: now };
  if (r.drop) return { ...ui, saving: false, saveTicket: null, revealing: false, words: null, key: null, expired: false, error: r.error, changedAt: now, gen: ui.gen + 1 };
  return { ...ui, saving: false, saveTicket: null, error: r.error, changedAt: now };
}

/** How long until the shown words hide themselves, on whichever clock
 *  comes first, or null when none show. */
export function wordsExpireIn(ui: BankBackupUi, now: number, wall: number = Date.now()): number | null {
  if (ui.words === null) return null;
  return Math.max(0, Math.min(ui.shownAt + WORDS_SHOWN_MS - now, ui.shownWall + WORDS_SHOWN_MS - wall));
}

// ── 🖥️ The desktop app's backup window ───────────────────────────────────────

/** OPEN BACKUP WINDOW: out, only in the native mode, for a wallet whose
 *  words are not marked saved, and not while one is out already (single
 *  flight). Returns the state it was given when it does not go. */
export function startBackupWindow(
  ui: BankBackupUi,
  fp: LocalFingerprint | null | undefined,
  shell: boolean,
  now: number,
): BankBackupUi {
  const address = backupMode(fp, shell) === 'native' ? backupAddress(fp, 'native') : null;
  if (ui.windowOpen || address === null || backedUp(fp)) return ui;
  return { ...ui, windowOpen: true, windowLine: null, windowFor: address, changedAt: now };
}

/** The app's answer: its fixed line, and OPEN BACKUP WINDOW is free again.
 *  The control changed what it shows, so the fresh-tap clock restarts. */
export function applyBackupWindow(ui: BankBackupUi, answer: NativeBackupAnswer, now: number): BankBackupUi {
  if (!ui.windowOpen) return ui;
  const line = Object.prototype.hasOwnProperty.call(BACKUP_WINDOW_LINES, answer) ? BACKUP_WINDOW_LINES[answer] : BACKUP_WINDOW_LINES.unavailable;
  return { ...ui, windowOpen: false, windowLine: line, changedAt: now };
}

/** What OPEN BACKUP WINDOW needs from its page. `open` is nativeShell.ts
 *  `openBackup` (no argument, a fixed answer); `refresh` reads the node's
 *  fingerprint again; `set` takes the next state and repaints. */
export interface BackupWindowDeps {
  get(): BankBackupUi;
  set(next: BankBackupUi): void;
  fingerprint(): LocalFingerprint | null | undefined;
  shell: boolean;
  open(): Promise<NativeBackupAnswer>;
  refresh(): Promise<unknown>;
  now(): number;
}

/** OPEN BACKUP WINDOW, start to end: the app's window opens, and once it
 *  closes its answer becomes a line and the fingerprint is read again, once,
 *  so the Bank shows what the node now holds (marked saved, or not). Null
 *  when it did not go (one is out, or not the native mode). Never throws,
 *  and never asks the node for the words or marks them saved itself. */
export async function runBackupWindow(d: BackupWindowDeps): Promise<NativeBackupAnswer | null> {
  const before = d.get();
  const started = startBackupWindow(before, d.fingerprint(), d.shell, d.now());
  if (started === before) return null;
  d.set(started);
  let answer: NativeBackupAnswer;
  try {
    answer = await d.open();
  } catch {
    answer = 'unavailable';
  }
  d.set(applyBackupWindow(d.get(), answer, d.now()));
  try {
    await d.refresh();
  } catch {
    // The next fingerprint round reads it.
  }
  return answer;
}

// ── Taps and keys ────────────────────────────────────────────────────────────

/** The fresh-tap rule for SHOW, ⚠ CONFIRM, OPEN BACKUP WINDOW and the
 *  wallet switch's CONFIRM, TURN OFF and KEEP IT ON: not the second click of a double-click
 *  (`detail > 1`; a keyboard click has 0), and not within BANK_SETTLE_MS of
 *  the control changing what it does. */
export function freshTap(detail: number, now: number, changedAt: number): boolean {
  return detail <= 1 && now - changedAt >= BANK_SETTLE_MS;
}

/** The controls a held Enter or Space must not repeat on: each keydown
 *  repeat would activate the button again. */
export const HELD_KEY_IDS: ReadonlySet<string> = new Set([BANK_WALLET_BUTTON_ID, BACKUP_SHOW_ID, BACKUP_SAVED_ID, BACKUP_WINDOW_ID]);

export function heldKeyRepeat(e: { repeat: boolean; key: string }, targetId: string | null | undefined): boolean {
  return e.repeat && (e.key === 'Enter' || e.key === ' ') && HELD_KEY_IDS.has(targetId ?? '');
}

// ── The two requests ─────────────────────────────────────────────────────────

/** A refusal or a failure, in the node's words or the page's. `refresh`:
 *  read the fingerprint again (the wallet may have changed). `saved`: the
 *  node has these words marked saved. `drop`: forget the shown words and the
 *  key; SHOW again. */
export interface BackupFailure {
  ok: false;
  error: string;
  refresh: boolean;
  saved: boolean;
  drop: boolean;
}

export type RevealResult = { ok: true; words: string[]; key: number; address: string } | BackupFailure;
export type SaveResult = { ok: true; note: string | null } | BackupFailure;

const fail = (error: string, flags: Partial<Omit<BackupFailure, 'ok' | 'error'>> = {}): BackupFailure =>
  ({ ok: false, error, refresh: false, saved: false, drop: false, ...flags });

const OLDER = "your station node is older than the Bank's BACK UP: update Star Station";
/** Either request on a network that is not a test one: nothing is sent. */
const NOT_TEST = 'your station node is not on a test network, so this page does not show the words';
const MALFORMED = "your station node's answer was not 24 words, so nothing is shown";
const CHANGED = 'the wallet changed under the Bank, so these words are not shown; look again';

const WORD = /^[a-z]{3,8}$/;

const isU32 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff;

/** Exactly 24 lowercase words of 3 to 8 letters (every BIP39 English word
 *  is), or null: never some of them. */
function asWords(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length !== WORD_COUNT) return null;
  for (const w of v) if (typeof w !== 'string' || !WORD.test(w)) return null;
  return (v as string[]).slice();
}

/** The node's own text, trimmed and cut to 400 characters, or ''. */
function nodeSaid(r: Record<string, unknown>, field: 'error' | 'note' = 'error'): string {
  const v = r[field];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 400) : '';
}

type Answer = { status: number; ok: boolean; body: Record<string, unknown> } | 'timeout' | 'unreachable';

/** A POST with no body and no custom header (a simple request, no
 *  preflight), no redirect (the answer must be the node's own), and nothing
 *  cached. The deadline covers the body too: a slow body is a timeout. */
async function ask(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Answer> {
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', signal: ctl.signal, redirect: 'error', cache: 'no-store' });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (e) {
      if (ctl.signal.aborted) throw e;
      // not JSON: worded from the status
    }
    const r = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    return { status: res.status, ok: res.ok, body: r };
  } catch {
    return ctl.signal.aborted ? 'timeout' : 'unreachable';
  } finally {
    clearTimeout(deadline);
  }
}

/** SHOW: ask the node at `origin` for the 24 words of the wallet whose
 *  address is `expectAddress`, on `net`. Never throws. A 200 is taken only
 *  whole: 24 words, a u32 key fingerprint, and that same address on `net`.
 *  Nothing is sent unless `net` is a test network. */
export async function revealWords(
  origin: string,
  expectAddress: string,
  net: ChiaNetwork | null | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = REVEAL_TIMEOUT_MS,
): Promise<RevealResult> {
  if (!net?.test) return fail(NOT_TEST);
  if (!origin) return fail('your station node is not answering, so the words are not shown');
  const got = await ask(`${origin}/api/chia/words`, fetchImpl, timeoutMs);
  if (got === 'timeout') return fail('your station node did not answer in time, so the words are not shown; tap SHOW again');
  if (got === 'unreachable') return fail('your station node could not be reached, so the words are not shown');
  if (got.status === 404) return fail(OLDER);
  if (got.ok) {
    const words = got.body.ok === true ? asWords(got.body.words) : null;
    const key = got.body.key;
    const address = got.body.address;
    if (!words || !isU32(key) || !isAddressOn(net, address)) return fail(MALFORMED);
    if (address !== expectAddress) return fail(CHANGED, { refresh: true });
    return { ok: true, words, key, address };
  }
  // The node's refusal: not the app's page (403), not on, turning, already
  // saved (409), or the words could not be read (500).
  const said = nodeSaid(got.body);
  return fail(said || `your station node answered ${got.status}, so the words are not shown`, {
    refresh: got.status === 409,
    saved: got.status === 409 && got.body.saved === true,
  });
}

/** I SAVED: tell the node at `origin` that the words of key fingerprint
 *  `key` are written down. Never throws. A key that is not a u32, or a
 *  `net` that is not a test network, is refused before anything is sent. */
export async function markWordsSaved(
  origin: string,
  key: number,
  net: ChiaNetwork | null | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = SAVE_TIMEOUT_MS,
): Promise<SaveResult> {
  if (!net?.test) return fail(NOT_TEST, { drop: true });
  const notRecorded = (why: string, refresh = false) =>
    fail(`the Bank could not record it: ${why}. Your words are fine; tap I SAVED again`, { refresh });
  if (!isU32(key)) return fail('the Bank has no key fingerprint to record; tap SHOW again', { drop: true });
  if (!origin) return notRecorded('your station node is not answering');
  const got = await ask(`${origin}/api/chia/words/saved?key=${key}`, fetchImpl, timeoutMs);
  // It may have landed: the fingerprint says, and I SAVED again is harmless.
  if (got === 'timeout') return notRecorded('your station node did not answer in time', true);
  if (got === 'unreachable') return notRecorded('your station node could not be reached');
  if (got.status === 404) return fail(OLDER);
  if (got.ok && got.body.ok === true) return { ok: true, note: nodeSaid(got.body, 'note') || null };
  if (got.status === 409 && got.body.saved === true) return { ok: true, note: null };
  const said = nodeSaid(got.body);
  // 409: not for this key (the wallet changed, or the node has not shown
  // these words since it started). SHOW again.
  if (got.status === 409) return fail(said || 'your station node answered 409; tap SHOW again', { refresh: true, drop: true });
  return said ? fail(said) : notRecorded(`your station node answered ${got.status}`);
}

// ── The clipboard ────────────────────────────────────────────────────────────

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/** COPY: the words, space-separated, nothing else. 'refused' when the page
 *  may not write the clipboard. */
export async function copyWords(words: readonly string[] | null, clip: ClipboardLike | null | undefined): Promise<'held' | 'refused'> {
  if (!clip || !words || words.length !== WORD_COUNT) return 'refused';
  try {
    await clip.writeText(words.join(' '));
    return 'held';
  } catch {
    return 'refused';
  }
}

/** Whether a wipe is worth trying: COPY left the words on the clipboard
 *  ('held'), or a wipe from the timer or the Bank leaving the screen was
 *  refused ('stuck') and this one comes from a panel tap, which a page with
 *  focus and a fresh gesture is allowed to write from. */
export function wipeWanted(copy: BackupCopy, onTap: boolean): boolean {
  return copy === 'held' || (onTap && copy === 'stuck');
}

/** Empty the clipboard, only when COPY left the words on it. A page cannot
 *  read the clipboard first without asking, so this empties whatever is on
 *  it; it is offered only from 'held', which the address's COPY ends, and
 *  on a panel tap from 'stuck' ([`wipeWanted`]). */
export async function wipeClipboard(copy: BackupCopy, clip: ClipboardLike | null | undefined, onTap = false): Promise<BackupCopy> {
  if (!wipeWanted(copy, onTap)) return copy;
  if (!clip) return 'stuck';
  try {
    await clip.writeText('');
    return 'wiped';
  } catch {
    return 'stuck';
  }
}

/** COPY's outcome. A refused COPY after one that took leaves the earlier
 *  words on the clipboard: that copy, its time and its wipe stand. */
export function afterCopy(ui: BankBackupUi, result: 'held' | 'refused', now: number): BankBackupUi {
  if (result === 'refused' && (ui.copy === 'held' || ui.copy === 'stuck')) return { ...ui, armed: false };
  return { ...ui, copy: result, copiedAt: result === 'held' ? now : ui.copiedAt, armed: false };
}

/** A wipe's outcome, for the copy it was started for only: a COPY or an
 *  address COPY since then stands, and so does a wipe that already landed. */
export function afterWipe(ui: BankBackupUi, copiedAt: number, result: BackupCopy): BankBackupUi {
  if ((ui.copy !== 'held' && ui.copy !== 'stuck') || ui.copiedAt !== copiedAt || result === 'held') return ui;
  return { ...ui, copy: result };
}

/** The address's COPY put the address over whatever was there: no words to
 *  wipe any more. */
export function afterAddressCopy(ui: BankBackupUi): BankBackupUi {
  return ui.copy === 'none' ? ui : { ...ui, copy: 'none', copiedAt: 0 };
}

export function clipboardWipeDue(ui: BankBackupUi, now: number): boolean {
  return ui.copy === 'held' && now - ui.copiedAt >= CLIPBOARD_WIPE_MS;
}

/** Whether the words a COPY wrote may stay on the clipboard once the write
 *  is done: only while the panel it was tapped in (`gen`, read before the
 *  write) still shows them on screen. A HIDE, LATER, expiry or another SHOW
 *  meanwhile abandoned that copy, so it is wiped at once, even when newer
 *  words are on screen; the player can COPY those again. */
export function copyStays(ui: BankBackupUi, gen: number, onScreen: boolean): boolean {
  return ui.words !== null && onScreen && ui.gen === gen;
}

// ── The grid ─────────────────────────────────────────────────────────────────

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CELL = 'display:flex; gap:5px; align-items:baseline; min-width:0; padding:3px 5px; border:1px solid rgba(212,168,75,0.2); border-radius:4px; font-size:10px; color:#f0c060; white-space:nowrap; overflow:hidden;';
const NUM = 'flex-shrink:0; min-width:2ch; text-align:right; font-size:8.5px; color:rgba(212,168,75,0.5);';

/** The 24 cells, row-major in three columns, numbered 1 to 24. Masked, they
 *  hold no word at all, not even in an attribute or behind CSS: every cell
 *  reads `N ••••••`. Shown, each word is an escaped text node, never an
 *  attribute. The grid cannot be selected (main.ts also refuses its `copy`
 *  event); COPY is the one way out, and it is deliberate. No live region:
 *  a screen reader reads the words only when asked. */
export function backupGridHtml(words: readonly string[] | null): string {
  const shown = words !== null && words.length === WORD_COUNT;
  const cells: string[] = [];
  for (let i = 0; i < WORD_COUNT; i++) {
    const n = i + 1;
    cells.push(shown
      ? `<li style="${CELL}"><span style="${NUM}">${n}</span><span>${escText((words as readonly string[])[i])}</span></li>`
      : `<li style="${CELL}" aria-label="word ${n}, hidden"><span style="${NUM}" aria-hidden="true">${n}</span><span aria-hidden="true">••••••</span></li>`);
  }
  return `<ol id="${BACKUP_GRID_ID}" aria-label="${shown ? 'The 24 words, in order' : 'The 24 words, hidden'}" style="list-style:none; margin:6px 0 0; padding:0; display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:4px; user-select:none; -webkit-user-select:none;">${cells.join('')}</ol>`;
}
