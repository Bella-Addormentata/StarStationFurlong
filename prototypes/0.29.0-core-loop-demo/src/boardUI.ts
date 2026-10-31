/**
 * 📌 A room board's focused panel (#315): every note in full, newest first,
 * the post box, and the controls.
 *
 *  - Anyone in the room posts on the corkboard; only the room owner posts in
 *    the notice case (boardDoc.canPost).
 *  - The author takes their own note down; the owner unpins anyone's note and
 *    can clear the board (two clicks).
 *  - HIDE puts away one author's notes on this player's own screen, kept on
 *    this machine only (boardDoc.setAuthorHidden).
 *  - Opening the board marks what is on it as seen, so the face's glow goes
 *    out. The notes that were new when the player walked up stay marked NEW
 *    in this panel until it closes. There is no count anywhere (Dorkmo
 *    2026-10-31).
 *
 * Who wrote a note: a saved contact's name with ✔ (the player's own record of
 * that key), else the name the author signed with and their key's
 * fingerprint, so two people can't pass for each other by name alone.
 *
 * Every peer-written string reaches the DOM through escapeHtml.
 *
 * The departures board's console idiom (devices.createDeparturesBoardUI):
 * a DOM panel mounted by deviceFocus. The post box is built once at mount
 * and never re-rendered, so a board change mid-sentence doesn't wipe what
 * the player is typing.
 */

import type { DeviceUI } from './devices';
import {
  BOARD_COLOURS,
  MAX_NOTE_TEXT,
  MAX_NOTES_PER_AUTHOR,
  boardOwnerPub,
  boardRoomId,
  canModerate,
  canPost,
  clearBoard,
  isHiddenAuthor,
  markBoardSeen,
  postNote,
  readBoard,
  setAuthorHidden,
  subscribeBoards,
  takeDownNote,
  trimBoard,
  unseenIds,
  type BoardColour,
  type BoardKind,
  type ShownNote,
} from './boardDoc';
import { NOTE_FILL } from './boardFace';
import { getContact } from './contacts';
import { escapeHtml } from './htmlEscape';
import { fingerprintOf, getIdentityPub } from './keypair';

export interface BoardUIDeps {
  itemId: string;
  kind: BoardKind;
  onEngagedChange?: (engaged: boolean) => void;
}

const GOLD = '#d4a84b';
const GOLD_BRIGHT = '#F0C060';
const DIM = '#6A7580';
const CLEAR_CONFIRM_MS = 4_000;
/** How often an open panel refreshes its "5 min ago" stamps. */
const AGE_REFRESH_S = 30;

/** "just now", "5 min ago", "3 h ago", "2 d ago", else the date. */
export function noteAge(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Who wrote a note, as this player can vouch for it. */
function authorLabel(n: ShownNote, me: string): string {
  if (n.author === me) return 'You';
  const contact = getContact(n.author);
  if (contact) return `${escapeHtml(contact.name)} ✔`;
  return `${escapeHtml(n.authorName)} · ${escapeHtml(fingerprintOf(n.author))}`;
}

const smallBtn = (act: string, label: string, extra = '', tone = GOLD): string => `<button data-act="${act}" ${extra} style="
    padding:3px 7px; background:rgba(212,168,75,0.06); border:1px solid ${tone}55; border-radius:5px;
    color:${tone}; font-family:inherit; font-size:9px; font-weight:800; letter-spacing:0.5px; cursor:pointer;">${label}</button>`;

/** 📌 By keyboard (#330 review): Tab is the phone's toggle, not a tab stop
 *  (main.ts), so the panel carries the terminal pane's traversal (devices.ts):
 *  ↑/↓ step through its visible controls, wrapping, and Enter and Space
 *  press a button natively. In the note box ↑ leaves only from its very
 *  start and ↓ only from its very end, so its own lines keep their caret
 *  keys. */
const NAV_STOPS = 'button:not([disabled]), textarea:not([disabled])';
const navStops = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(NAV_STOPS)].filter((el) => el.offsetParent !== null);
/** What a control does and to what, so focus survives a repaint that
 *  rebuilds it. */
const stopKey = (el: HTMLElement): string =>
  [el.dataset.act ?? (el.hasAttribute('data-text') ? 'text' : ''), el.dataset.id ?? '', el.dataset.pub ?? '', el.dataset.colour ?? ''].join('|');

export function createBoardUI(deps: BoardUIDeps): DeviceUI {
  const { itemId, kind } = deps;
  const open = kind === 'open';
  let panel: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let since = 0;
  /** The notes that were unseen when the player walked up, or that arrived
   *  while they read: marked NEW in the panel until it closes. */
  const fresh = new Set<string>();
  /** The room the panel was opened in. An ACCESS beam rebinds the board
   *  store to the next room before the panel comes down (#330 review), and
   *  the same item id can be a board there too: until the panel closes, it
   *  marks, posts and draws nothing anywhere else. */
  let roomAtMount = '';
  const here = (): boolean => roomAtMount !== '' && boardRoomId() === roomAtMount;
  /** Notes unseen now join the NEW set, then count as seen on the face. */
  const takeInNew = (): void => {
    for (const id of unseenIds(itemId, kind)) fresh.add(id);
    markBoardSeen(itemId, kind);
  };
  let colour: BoardColour = open ? 'yellow' : 'white';
  let clearArmedUntil = 0;
  let status = '';

  const notesHtml = (): string => {
    const me = getIdentityPub();
    const owner = boardOwnerPub();
    const moderator = canModerate();
    const now = Date.now();
    const notes = readBoard(itemId, kind).shown.filter((n) => !isHiddenAuthor(n.author));
    if (notes.length === 0) {
      const why = !open && !owner
        ? 'The owner’s key hasn’t arrived yet, so notices can’t be checked.'
        : open ? 'Nothing pinned yet.' : 'No notices.';
      return `<span style="font-size:10px; color:${DIM};">${why}</span>`;
    }
    return notes.map((n) => {
      const isNew = n.author !== me && fresh.has(n.id);
      const mine = n.author === me;
      const photo = n.attach
        ? `<div style="font-size:9.5px; color:${DIM}; margin-top:4px;">📷 Photo${n.attach.caption ? ` · ${escapeHtml(n.attach.caption)}` : ''} <span style="opacity:0.7;">(shows with the camera app)</span></div>`
        : '';
      const buttons = [
        mine ? smallBtn('down', 'TAKE DOWN', `data-id="${escapeHtml(n.id)}"`) : '',
        !mine && moderator ? smallBtn('down', 'UNPIN', `data-id="${escapeHtml(n.id)}"`, '#FF6B6B') : '',
        !mine && open ? smallBtn('hide', 'HIDE', `data-pub="${escapeHtml(n.author)}"`, DIM) : '',
      ].join('');
      return `<div style="
          border-left:4px solid ${NOTE_FILL[n.colour]}; background:rgba(255,255,255,0.03);
          border-radius:6px; padding:8px 10px;
          ${isNew ? 'box-shadow:0 0 0 1px rgba(255,236,140,0.55), 0 0 14px rgba(255,236,140,0.25);' : ''}">
        <div style="font-size:11px; line-height:1.45; color:#E8E2D0; white-space:pre-wrap; word-break:break-word;">${escapeHtml(n.text)}</div>
        ${photo}
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-top:6px;">
          <span style="font-size:9px; color:${DIM};">
            ${isNew ? `<span style="color:#FFE88C; font-weight:800;">NEW</span> · ` : ''}${authorLabel(n, me)}${owner && n.author === owner ? ` · <span style="color:${GOLD_BRIGHT};">OWNER</span>` : ''} · ${noteAge(n.ts, now)}
          </span>
          <span style="display:flex; gap:4px;">${buttons}</span>
        </div>
      </div>`;
    }).join('');
  };

  /** Authors this player hid who have notes on this board, to show again.
   *  On the notice case too (#330 review): the hidden list is one for every
   *  board, so hiding someone on a corkboard hides their notices as well, and
   *  the case must offer them back. */
  const hiddenHtml = (): string => {
    const byAuthor = new Map<string, string>();
    for (const n of readBoard(itemId, kind).shown) {
      if (isHiddenAuthor(n.author) && !byAuthor.has(n.author)) byAuthor.set(n.author, n.authorName);
    }
    if (byAuthor.size === 0) return '';
    const rows = [...byAuthor].map(([pub, name]) =>
      `<span style="display:inline-flex; gap:4px; align-items:center; margin-right:8px;">${escapeHtml(getContact(pub)?.name ?? name)} ${smallBtn('show', 'SHOW', `data-pub="${escapeHtml(pub)}"`, DIM)}</span>`,
    ).join('');
    return `<div style="font-size:9.5px; color:${DIM}; line-height:1.9;">Hidden on your screen: ${rows}</div>`;
  };

  const render = (): void => {
    if (!panel || !here()) return;
    // The lists below are rebuilt; a control that held focus comes back as
    // its twin, or the panel holds focus, never the page's body.
    const active = document.activeElement;
    const held = active instanceof HTMLElement && active !== panel && panel.contains(active) ? stopKey(active) : null;
    const notes = panel.querySelector<HTMLElement>('[data-notes]');
    if (notes) notes.innerHTML = notesHtml();
    const hidden = panel.querySelector<HTMLElement>('[data-hidden]');
    if (hidden) hidden.innerHTML = hiddenHtml();
    // The post box: shown when this player may post (the deed can land
    // after the panel opens), else why not.
    const may = canPost(kind);
    const form = panel.querySelector<HTMLElement>('[data-form]');
    const refusal = panel.querySelector<HTMLElement>('[data-refusal]');
    if (form) form.style.display = may ? 'flex' : 'none';
    if (refusal) refusal.style.display = may ? 'none' : 'block';
    panel.querySelectorAll<HTMLButtonElement>('[data-act="colour"]').forEach((b) => {
      const on = b.dataset.colour === colour;
      b.style.outline = on ? `2px solid ${GOLD_BRIGHT}` : 'none';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const statusEl = panel.querySelector<HTMLElement>('[data-status]');
    if (statusEl) statusEl.textContent = status;
    const tools = panel.querySelector<HTMLElement>('[data-tools]');
    if (tools) {
      const armed = Date.now() < clearArmedUntil;
      tools.style.display = canModerate() ? 'flex' : 'none';
      tools.innerHTML = smallBtn('clear', armed ? 'CLICK AGAIN TO CLEAR EVERY NOTE' : 'CLEAR BOARD', '', '#FF6B6B');
    }
    if (held !== null && !panel.contains(document.activeElement)) {
      (navStops(panel).find((el) => stopKey(el) === held) ?? panel).focus({ preventScroll: true });
    }
  };

  const post = (): void => {
    if (!panel || !here()) return;
    const box = panel.querySelector<HTMLTextAreaElement>('[data-text]');
    if (!box) return;
    const result = postNote(itemId, kind, { text: box.value, colour });
    if (result.ok) {
      box.value = '';
      status = 'Pinned.';
      updateCount();
    } else {
      status = result.why;
    }
    render();
  };

  const updateCount = (): void => {
    const box = panel?.querySelector<HTMLTextAreaElement>('[data-text]');
    const count = panel?.querySelector<HTMLElement>('[data-count]');
    if (box && count) count.textContent = `${box.value.length}/${MAX_NOTE_TEXT}`;
  };

  const onClick = (e: MouseEvent): void => {
    e.stopPropagation();
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]');
    if (!btn || !here()) return;
    switch (btn.dataset.act) {
      case 'down':
        if (btn.dataset.id && !takeDownNote(itemId, btn.dataset.id, kind)) status = 'That note is already gone.';
        break;
      case 'hide':
        if (btn.dataset.pub) setAuthorHidden(btn.dataset.pub, true);
        break;
      case 'show':
        if (btn.dataset.pub) setAuthorHidden(btn.dataset.pub, false);
        break;
      case 'colour':
        if ((BOARD_COLOURS as readonly string[]).includes(btn.dataset.colour ?? '')) colour = btn.dataset.colour as BoardColour;
        break;
      case 'post':
        post();
        return;
      case 'clear':
        if (Date.now() < clearArmedUntil) {
          clearArmedUntil = 0;
          status = clearBoard(itemId) ? 'Board cleared.' : 'Nothing to clear.';
        } else {
          clearArmedUntil = Date.now() + CLEAR_CONFIRM_MS;
        }
        break;
    }
    render();
  };

  const swatches = BOARD_COLOURS.map((c) => `<button data-act="colour" data-colour="${c}" title="${c}" aria-label="${c} note" style="
      width:20px; height:20px; border-radius:4px; border:1px solid rgba(0,0,0,0.4);
      background:${NOTE_FILL[c]}; cursor:pointer; padding:0;"></button>`).join('');

  const shell = (): string => `
    <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:8px;">
      <span style="font-size:12px; font-weight:800; color:${GOLD_BRIGHT}; letter-spacing:1px;">${open ? '📌 CORKBOARD' : '🔒 NOTICE CASE'}</span>
      <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / CLICK AWAY TO STEP BACK</span>
    </div>
    <div style="font-size:9.5px; line-height:1.45; color:${DIM};">
      ${open
        ? `Anyone in this room can pin a note. Each note is signed with its writer’s key. You can have ${MAX_NOTES_PER_AUTHOR} notes here; a new one replaces your oldest.`
        : 'Official notices from the room’s owner, behind locked glass. Each one is signed with the owner’s key.'}
    </div>
    <div data-notes style="display:flex; flex-direction:column; gap:8px;"></div>
    <div data-hidden></div>
    <div style="border-top:1px solid rgba(212,168,75,0.12); padding-top:10px;">
      <div data-form style="display:none; flex-direction:column; gap:6px;">
        <textarea data-text maxlength="${MAX_NOTE_TEXT}" rows="3" placeholder="${open ? 'Write a note…' : 'Write a notice…'}" style="
          width:100%; box-sizing:border-box; resize:vertical; background:rgba(255,255,255,0.04);
          border:1px solid rgba(212,168,75,0.3); border-radius:6px; color:#E8E2D0;
          font-family:inherit; font-size:11px; padding:7px;"></textarea>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
          <span style="display:flex; gap:5px;">${swatches}</span>
          <span data-count style="font-size:9px; color:${DIM};">0/${MAX_NOTE_TEXT}</span>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
          <span data-status style="font-size:9.5px; color:${GOLD};"></span>
          <button data-act="post" style="
            padding:7px 14px; background:rgba(47,230,160,0.12); border:1px solid #2fe6a0; border-radius:7px;
            color:#2fe6a0; font-family:inherit; font-size:10px; font-weight:800; letter-spacing:0.5px; cursor:pointer;">${open ? 'PIN IT' : 'POST NOTICE'}</button>
        </div>
      </div>
      <div data-refusal style="display:none; font-size:9.5px; color:${DIM};">
        ${open ? 'This board isn’t loaded yet.' : 'Only the room owner can post in the notice case.'}
      </div>
    </div>
    <div data-tools style="display:none; justify-content:flex-end;"></div>
    <div style="font-size:9px; color:#33404E; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px;">
      SSF BOARD v1 · notes live in this room and travel with it
    </div>
  `;

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = 'device-board-pane';
      panel.style.cssText = `
        position: absolute; top: 50%; right: max(16px, 4vw); transform: translateY(-50%);
        width: min(380px, calc(100vw - 32px)); max-height: 88vh; overflow-y: auto;
        background: rgba(4, 8, 22, 0.94); border: 1px solid rgba(212, 168, 75, 0.28);
        border-radius: 12px; box-shadow: 0 12px 64px rgba(0,0,0,0.9);
        padding: 18px; display: flex; flex-direction: column; gap: 12px;
        color: ${GOLD}; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        box-sizing: border-box; pointer-events: auto; outline: none;
      `;
      panel.innerHTML = shell();
      panel.addEventListener('click', onClick);
      const box = panel.querySelector<HTMLTextAreaElement>('[data-text]');
      box?.addEventListener('input', () => {
        updateCount();
        if (status) {
          status = '';
          const el = panel?.querySelector<HTMLElement>('[data-status]');
          if (el) el.textContent = '';
        }
      });
      // Ctrl/Cmd+Enter pins; a plain Enter is a new line.
      box?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          post();
        }
      });
      const mounted = panel;
      mounted.setAttribute('tabindex', '-1'); // focusable by script, never a tab stop
      mounted.addEventListener('keydown', (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const from = e.target instanceof HTMLElement ? e.target : null;
        if (from instanceof HTMLTextAreaElement) {
          const edge = step < 0 ? 0 : from.value.length;
          if (from.selectionStart !== edge || from.selectionEnd !== edge) return; // the box's own lines
        }
        const stops = navStops(mounted);
        if (stops.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const at = from ? stops.indexOf(from) : -1;
        const next = stops[at < 0 ? 0 : (at + step + stops.length) % stops.length];
        next.focus({ preventScroll: true });
        next.scrollIntoView({ block: 'nearest' });
      });
      host.appendChild(panel);
      // What was new when the player walked up stays marked NEW here; the
      // face's glow goes out now that they've seen it.
      roomAtMount = boardRoomId();
      takeInNew();
      trimBoard(itemId, kind);
      unsubscribe = subscribeBoards(() => {
        if (!here()) return;
        // A note pinned while the player reads the board is NEW here and
        // seen on the face.
        takeInNew();
        render();
      });
      deps.onEngagedChange?.(true);
      render();
      // Somewhere to start from: ↑/↓ from the panel itself land on its
      // first control, and nothing is typed into the note box by accident.
      mounted.focus({ preventScroll: true });
    },
    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      deps.onEngagedChange?.(false);
      panel?.remove();
      panel = null;
    },
    update(dt: number): void {
      if (!panel || !here()) return;
      // An armed CLEAR disarms itself.
      if (clearArmedUntil && Date.now() >= clearArmedUntil) {
        clearArmedUntil = 0;
        render();
      }
      since += dt;
      if (since < AGE_REFRESH_S) return;
      since = 0;
      // The ages move on, and a note stamped a little ahead can come due with
      // no change to the map (#330 review): it is NEW here and seen on the
      // face like one that arrives, and the hidden list is redrawn with it.
      takeInNew();
      render();
    },
  };
}
