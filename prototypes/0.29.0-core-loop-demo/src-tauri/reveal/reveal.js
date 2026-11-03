// The backup window's page (src-tauri/reveal, served by the app's ssfreveal
// scheme). It shows the SSF wallet's 24 words on request, for the player to
// write on paper, and tells the node when they are saved. It copies the
// Bank's rules (src/bankBackup.ts):
// - it opens masked, with the network, the address (kept but hidden while
//   Chia is off on this computer, as the Bank shows none then, and hidden
//   as soon as a reveal says Chia was turned off since the window opened)
//   and the line that Star Station never asks for the words;
// - SHOW needs a fresh click: not the second click of a double-click, not
//   within half a second of the control changing, and a held Enter or Space
//   never repeats it; HIDE acts at once, always;
// - the words go into text nodes of a list that cannot be selected, and
//   copying is cancelled;
// - they hide on HIDE, after five minutes on either clock, when the window
//   loses focus, when it is hidden, when it closes and before a print, and
//   the print shortcut is cancelled (reveal.css prints nothing of the page);
// - I SAVED arms CONFIRM, which needs a fresh click of its own; SHOW puts
//   CONFIRM back to I SAVED.
// The words come from the app on every SHOW and are never stored. The page
// calls the app's two backup commands and nothing else.
'use strict';

(function () {
  /** The words hide themselves this long after SHOW (bankBackup.ts). */
  const WORDS_SHOWN_MS = 300000;
  /** A click this soon after a control changed what it does is the second
   *  half of a double-click or a held key, not a decision. */
  const SETTLE_MS = 500;
  const WORD_COUNT = 24;
  const MASK = '••••••';

  const list = document.getElementById('words');
  const showButton = document.getElementById('show');
  const savedButton = document.getElementById('saved');
  const status = document.getElementById('status');
  const addressShown = document.getElementById('address').textContent;
  const addressLine = document.getElementById('address-line');
  const addressHint = document.getElementById('address-hint');

  const LINES = {
    no_channel: 'The app lost its link to your node. Close this window and open it again from the Bank.',
    already_saved: 'These words are marked saved already, so they are not shown again. Close this window.',
    changed: 'The wallet changed since this window opened. Close it and open it again from the Bank.',
    not_shown: 'Tap SHOW first, and check the words against your paper.',
  };
  const REVEAL_FAILED = 'Your node did not show the words. Close this window and try again from the Bank.';
  const SAVE_FAILED = 'Your node did not record it. Your words are fine: tap SHOW, check them, then I SAVED again.';
  const SHOWING = 'Write them down in order. They hide after five minutes, or as soon as this window loses focus.';
  const ARMED = 'Written all 24, in order? Your node stops asking and will not show them again. Tap CONFIRM.';
  const EXPIRED = 'The words hid themselves after five minutes. Tap SHOW to see them again.';
  const SAVED = 'Saved. Your node will not show these words again. This window closes now.';
  /** The hint while Chia is off on this computer (reveal.rs
   *  ADDRESS_LINES_CHIA_OFF). */
  const CHIA_OFF_HINT = 'Chia is off on this computer, so the Bank shows no address to check this window against.';

  let shown = false;
  let shownAt = 0;
  let shownWall = 0;
  let timer = null;
  /** Bumped at every hide and every SHOW: an answer lands only for its own. */
  let gen = 0;
  let asking = false;
  let saving = false;
  let armed = false;
  /** A reveal in this window gave the app the key that I SAVED records. */
  let revealed = false;
  const changedAt = { show: performance.now(), saved: performance.now() };

  function ask(command) {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') return Promise.reject('no_channel');
    return internals.invoke(command);
  }

  function fresh(event, control) {
    return event.detail <= 1 && performance.now() - changedAt[control] >= SETTLE_MS;
  }

  function say(text, bad) {
    status.textContent = text || '';
    status.classList.toggle('bad', Boolean(bad));
  }

  /** SHOW waits for any request that is out; HIDE never does, so words on
   *  screen can always be hidden, a slow CONFIRM included. */
  function sync() {
    showButton.disabled = !shown && (asking || saving);
    savedButton.disabled = !revealed || asking || saving;
  }

  function item(text) {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }

  function paintMasked() {
    const items = [];
    for (let i = 0; i < WORD_COUNT; i += 1) items.push(item(MASK));
    list.replaceChildren(...items);
    list.classList.add('masked');
  }

  function paintWords(words) {
    list.replaceChildren(...words.map(item));
    list.classList.remove('masked');
  }

  function disarm() {
    armed = false;
    savedButton.textContent = 'I SAVED';
    savedButton.classList.remove('danger');
    changedAt.saved = performance.now();
  }

  /** Mask the words (and drop any answer still out). */
  function hide(line, bad) {
    gen += 1;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    shown = false;
    paintMasked();
    showButton.textContent = 'SHOW';
    changedAt.show = performance.now();
    if (armed) disarm();
    if (line !== undefined) say(line, bad);
    sync();
  }

  function expired() {
    return shown && (performance.now() - shownAt >= WORDS_SHOWN_MS || Date.now() - shownWall >= WORDS_SHOWN_MS);
  }

  function onScreen() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  /** Chia was turned off in the game since the window opened: the Bank
   *  shows no address now, so the address line hides (kept, as every reveal
   *  is checked against it) and the hint says why. Chia does not come back
   *  on before the node stops, so neither does the line. */
  function chiaTurnedOff() {
    addressLine.hidden = true;
    addressHint.textContent = CHIA_OFF_HINT;
  }

  function wellFormed(words) {
    return Array.isArray(words) && words.length === WORD_COUNT && words.every((w) => typeof w === 'string' && /^[a-z]{3,8}$/.test(w));
  }

  function reveal() {
    if (asking || saving) return;
    // A CONFIRM armed while the words were masked does not come back armed
    // with them (bankBackup.ts startReveal).
    if (armed) disarm();
    asking = true;
    gen += 1;
    const ticket = gen;
    say('Asking your node…');
    sync();
    ask('backup_reveal')
      .then(
        (answer) => {
          if (answer && answer.chia_off === true) chiaTurnedOff();
          if (ticket !== gen || !onScreen()) {
            say('');
            return;
          }
          if (!answer || !wellFormed(answer.words)) {
            say(REVEAL_FAILED, true);
            return;
          }
          if (answer.address !== addressShown) {
            say(LINES.changed, true);
            return;
          }
          paintWords(answer.words);
          shown = true;
          revealed = true;
          shownAt = performance.now();
          shownWall = Date.now();
          timer = setInterval(() => {
            if (expired()) hide(EXPIRED);
          }, 1000);
          showButton.textContent = 'HIDE';
          // Both controls settle again once the words land (bankBackup.ts
          // applyReveal).
          changedAt.show = performance.now();
          changedAt.saved = changedAt.show;
          say(SHOWING);
        },
        (code) => {
          if (ticket !== gen) return;
          say(LINES[code] || REVEAL_FAILED, true);
        },
      )
      .finally(() => {
        asking = false;
        sync();
      });
  }

  function confirmSaved() {
    if (asking || saving || !revealed) return;
    saving = true;
    disarm();
    say('Telling your node…');
    sync();
    ask('backup_saved')
      .then(
        () => hide(SAVED),
        (code) => say(code === 'no_channel' || code === 'not_shown' ? LINES[code] : SAVE_FAILED, true),
      )
      .finally(() => {
        saving = false;
        sync();
      });
  }

  showButton.addEventListener('click', (event) => {
    // HIDE acts at once, always: hiding is never the risky way round.
    if (shown) {
      hide('');
      return;
    }
    if (!fresh(event, 'show')) return;
    reveal();
  });

  savedButton.addEventListener('click', (event) => {
    if (asking || saving || !revealed) return;
    if (!armed) {
      armed = true;
      savedButton.textContent = '⚠ CONFIRM';
      savedButton.classList.add('danger');
      changedAt.saved = performance.now();
      say(ARMED);
      return;
    }
    if (!fresh(event, 'saved')) return;
    confirmSaved();
  });

  // A held Enter or Space must not press SHOW or CONFIRM again, and the
  // print shortcut does not print this page (paper only means the player's
  // own hand, not a printer or a print-to-file).
  document.addEventListener(
    'keydown',
    (event) => {
      if ((event.ctrlKey || event.metaKey) && typeof event.key === 'string' && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        event.stopPropagation();
        hide();
        return;
      }
      const held = event.repeat && (event.key === 'Enter' || event.key === ' ');
      if (held && (event.target === showButton || event.target === savedButton)) event.preventDefault();
    },
    true,
  );

  // The words leave the screen with the window's focus, when it is hidden
  // and when it closes.
  window.addEventListener('blur', () => hide());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') hide();
  });
  window.addEventListener('pagehide', () => hide());
  window.addEventListener('beforeunload', () => hide());
  // A print that starts anyway finds the words masked; reveal.css also
  // leaves the page out of any printout.
  window.addEventListener('beforeprint', () => hide());

  // Paper only: no copy, no cut, no drag, no selection, no context menu.
  for (const name of ['copy', 'cut', 'dragstart', 'contextmenu']) {
    document.addEventListener(name, (event) => event.preventDefault(), true);
  }
  list.addEventListener('selectstart', (event) => event.preventDefault());

  paintMasked();
  sync();
})();
