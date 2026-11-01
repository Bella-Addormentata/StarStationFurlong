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
 * 📷 A note can carry a photo from the player's CAMERA film roll (#315 PR 5,
 * boardPhotos.ts): ADD A PHOTO picks a shot, PIN IT puts it on their node and
 * pins the note naming it. A photo shows here once this viewer's node holds
 * it; photos under a small cap come by themselves (the switch at the foot),
 * and FETCH asks for one that doesn't.
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
  type BoardPhoto,
  type ShownNote,
} from './boardDoc';
import { NOTE_FILL } from './boardFace';
import {
  PHOTO_AUTO_FETCH_DAY,
  PHOTO_AUTO_FETCH_MAX,
  photoAutoFetch,
  photoFromShot,
  photoLook,
  photoPicture,
  photoTrouble,
  pressFetch,
} from './boardPhotos';
import { formatBytes } from './blobLane';
import { getContact } from './contacts';
import { listShots, shotLabel, type FilmShot } from './filmRoll';
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
/** How often an open panel looks whether a photo moved along. */
const PHOTO_REFRESH_S = 1;

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

/** Why a photo waits for FETCH rather than coming by itself. */
function waitsWhy(size: number, hash: string): string {
  switch (photoAutoFetch.verdict(hash, size)) {
    case 'off': return 'Photos don’t come by themselves while that’s off below.';
    case 'big': return `It’s bigger than the ${formatBytes(PHOTO_AUTO_FETCH_MAX)} a photo takes by itself.`;
    case 'day': return `Today’s ${formatBytes(PHOTO_AUTO_FETCH_DAY)} for photos is used up.`;
    default: return '';
  }
}

/** A note's photo in the panel: the picture (bigger at a press), or where it
 *  is and the FETCH press, then its caption and who took it when. */
function photoHtml(n: ShownNote, me: string, big: boolean): string {
  const a = n.attach!;
  const look = photoLook(a);
  const pic = look === 'ready' ? photoPicture(a.hash) : null;
  const when = new Date(a.takenAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const caption = `<div style="font-size:9.5px; color:${DIM}; margin-top:4px;">📷 ${a.caption ? `${escapeHtml(a.caption)} · ` : ''}taken ${escapeHtml(when)} by ${authorLabel(n, me)}</div>`;
  if (pic) {
    return `<button data-act="zoom" data-id="${escapeHtml(n.id)}" aria-label="${big ? 'Show the photo small' : 'Show the photo big'}" style="
        display:block; padding:0; margin-top:6px; border:0; background:none; cursor:${big ? 'zoom-out' : 'zoom-in'};">
        <img src="${escapeHtml(pic.url)}" alt="${escapeHtml(a.caption || 'A photo')}" style="
          display:block; width:${big ? '100%' : '132px'}; max-width:100%; box-sizing:border-box; background:#FBFAF6;
          border:4px solid #FBFAF6; border-bottom-width:14px; border-radius:2px; box-shadow:0 3px 10px rgba(0,0,0,0.6);">
      </button>${caption}`;
  }
  const size = formatBytes(a.size);
  const fetchBtn = `<button data-act="fetch" data-id="${escapeHtml(n.id)}" data-hash="${escapeHtml(a.hash)}" style="
      margin-top:6px; padding:4px 9px; background:rgba(47,230,160,0.1); border:1px solid #2fe6a0; border-radius:6px;
      color:#2fe6a0; font-family:inherit; font-size:9.5px; font-weight:800; letter-spacing:0.5px; cursor:pointer;">📦 FETCH ${escapeHtml(size)}</button>`;
  const trouble = photoTrouble(a);
  const says = look === 'loading'
    ? 'Photo loading…'
    : look === 'no-node'
      ? 'Photos come from the sharer’s node to yours: they need this station’s node (the desktop app) running here.'
      : look === 'unreachable'
        ? `The sharer’s node isn’t reachable from here${trouble ? ` (${escapeHtml(trouble)})` : ''}. It comes once a node that has it is in the room.`
        : `${escapeHtml(waitsWhy(a.size, a.hash))} Your node takes it from the sharer’s node or another in this room that has it.`;
  const press = look === 'fetch' || look === 'unreachable' ? fetchBtn : '';
  return `<div style="margin-top:6px; padding:8px; border:1px dashed rgba(212,168,75,0.3); border-radius:6px; font-size:9.5px; line-height:1.45; color:${DIM};">
      ${says}${press ? `<div>${press}</div>` : ''}
    </div>${caption}`;
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
  /** 📷 The note whose photo shows big, if any. */
  let zoomed: string | null = null;
  /** The film-roll shot the next note carries, and the roll while the
   *  picker is open. Their thumbnails' object URLs go when the panel does. */
  let chosen: FilmShot | null = null;
  let roll: FilmShot[] | null = null;
  const thumbUrls = new Map<string, string>();
  const thumbOf = (shot: FilmShot): string => {
    let url = thumbUrls.get(shot.id);
    if (!url) {
      url = URL.createObjectURL(shot.jpeg);
      thumbUrls.set(shot.id, url);
    }
    return url;
  };
  /** A post is on its way (its photo going to the player's node). */
  let posting = false;
  let photoSince = 0;
  let photoKey = '';
  /** Every photo note's look now, which moves them along too. */
  const photoLooks = (): string =>
    readBoard(itemId, kind).shown.filter((n) => n.attach && !isHiddenAuthor(n.author)).map((n) => `${n.id}:${photoLook(n.attach!)}`).join(',');

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
      const photo = n.attach ? photoHtml(n, me, zoomed === n.id) : '';
      const buttons = [
        mine ? smallBtn('down', 'TAKE DOWN', `data-id="${escapeHtml(n.id)}"`) : '',
        !mine && moderator ? smallBtn('down', 'UNPIN', `data-id="${escapeHtml(n.id)}"`, '#FF6B6B') : '',
        !mine && open ? smallBtn('hide', 'HIDE', `data-pub="${escapeHtml(n.author)}"`, DIM) : '',
      ].join('');
      return `<div style="
          border-left:4px solid ${NOTE_FILL[n.colour]}; background:rgba(255,255,255,0.03);
          border-radius:6px; padding:8px 10px;
          ${isNew ? 'box-shadow:0 0 0 1px rgba(255,236,140,0.55), 0 0 14px rgba(255,236,140,0.25);' : ''}">
        ${n.text.trim() ? `<div style="font-size:11px; line-height:1.45; color:#E8E2D0; white-space:pre-wrap; word-break:break-word;">${escapeHtml(n.text)}</div>` : ''}
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
    const postBtn = panel.querySelector<HTMLButtonElement>('[data-act="post"]');
    if (postBtn) postBtn.disabled = posting;
    paintPhotoRow();
    const auto = panel.querySelector<HTMLElement>('[data-auto]');
    if (auto) {
      const on = photoAutoFetch.on();
      auto.innerHTML = `Photos up to ${formatBytes(PHOTO_AUTO_FETCH_MAX)} come to your node by themselves, ${formatBytes(PHOTO_AUTO_FETCH_DAY)} a day at most. ${smallBtn('auto', on ? 'BY THEMSELVES: ON' : 'BY THEMSELVES: OFF', `aria-pressed="${on ? 'true' : 'false'}"`, on ? GOLD : DIM)}`;
    }
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

  /** The post box's photo row and the film-roll picker. Built apart from
   *  the note box, which a repaint never touches. */
  const paintPhotoRow = (): void => {
    if (!panel) return;
    const row = panel.querySelector<HTMLElement>('[data-chosen]');
    if (row) {
      row.innerHTML = chosen
        ? `<img src="${escapeHtml(thumbOf(chosen))}" alt="" style="width:36px; height:36px; object-fit:cover; border:2px solid #FBFAF6; border-radius:2px;">
           <span style="font-size:9px; color:${DIM};">${escapeHtml(chosen.caption || shotLabel(chosen))}</span>
           ${smallBtn('unpick', '✕', 'aria-label="Take the photo off this note"', DIM)}`
        : '';
    }
    const pickBtn = panel.querySelector<HTMLElement>('[data-act="pick"]');
    if (pickBtn) pickBtn.textContent = roll ? 'CLOSE THE ROLL' : chosen ? '📷 ANOTHER PHOTO' : '📷 ADD A PHOTO';
    const picker = panel.querySelector<HTMLElement>('[data-picker]');
    if (!picker) return;
    picker.style.display = roll ? 'flex' : 'none';
    if (!roll) {
      picker.innerHTML = '';
      return;
    }
    picker.innerHTML = roll.length === 0
      ? `<span style="font-size:9.5px; color:${DIM};">Your film roll is empty. Open 📷 CAMERA on your SpacePhone to take a shot.</span>`
      : roll.map((shot) => `<button data-act="pick-shot" data-shot="${escapeHtml(shot.id)}" data-id="${escapeHtml(shot.id)}" title="${escapeHtml(shot.caption || shotLabel(shot))}" aria-label="Pin ${escapeHtml(shot.caption || shotLabel(shot))}" style="
          padding:0; border:2px solid ${chosen?.id === shot.id ? GOLD_BRIGHT : '#FBFAF6'}; border-radius:2px; background:#FBFAF6; cursor:pointer;">
          <img src="${escapeHtml(thumbOf(shot))}" alt="" style="display:block; width:52px; height:52px; object-fit:cover;"></button>`).join('');
  };

  const post = async (): Promise<void> => {
    if (!panel || !here() || posting) return;
    const box = panel.querySelector<HTMLTextAreaElement>('[data-text]');
    if (!box) return;
    const shot = chosen;
    let attach: BoardPhoto | undefined;
    if (shot) {
      posting = true;
      status = 'Handing the photo to your node…';
      render();
      const got = await photoFromShot(shot);
      posting = false;
      // The panel may have closed, or moved rooms, while the node took it.
      if (!panel || !here()) return;
      if ('error' in got) {
        status = got.error;
        render();
        return;
      }
      attach = got.photo;
    }
    const result = postNote(itemId, kind, { text: box.value, colour, ...(attach ? { attach } : {}) });
    if (result.ok) {
      box.value = '';
      if (shot && chosen?.id === shot.id) chosen = null;
      status = 'Pinned.';
      updateCount();
    } else {
      status = result.why;
    }
    render();
  };

  const openRoll = async (): Promise<void> => {
    const shots = await listShots();
    if (!panel || !here()) return;
    roll = shots;
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
        void post();
        return;
      case 'zoom':
        zoomed = zoomed === btn.dataset.id ? null : btn.dataset.id ?? null;
        break;
      case 'fetch': {
        // The press is for the photo the button showed: a note filed under
        // the same id carries the same signed photo, but the hash is checked
        // anyway (the theatre's FETCH rule).
        const n = readBoard(itemId, kind).shown.find((x) => x.id === btn.dataset.id);
        if (n?.attach && n.attach.hash === btn.dataset.hash) void pressFetch(n.attach);
        break;
      }
      case 'auto':
        photoAutoFetch.setOn(!photoAutoFetch.on());
        break;
      case 'pick':
        if (roll) roll = null;
        else void openRoll();
        break;
      case 'pick-shot': {
        const shot = roll?.find((x) => x.id === btn.dataset.shot);
        if (shot) {
          chosen = shot;
          roll = null;
          status = '';
        }
        break;
      }
      case 'unpick':
        chosen = null;
        break;
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
        ? `Anyone in this room can pin a note, with a photo from their CAMERA if they like. Each note is signed with its writer’s key. You can have ${MAX_NOTES_PER_AUTHOR} notes here; a new one replaces your oldest.`
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
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          ${smallBtn('pick', '📷 ADD A PHOTO')}
          <span data-chosen style="display:flex; align-items:center; gap:6px;"></span>
        </div>
        <div data-picker style="display:none; flex-wrap:wrap; gap:5px; max-height:132px; overflow-y:auto;"></div>
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
    <div data-auto style="font-size:9px; line-height:1.8; color:${DIM};"></div>
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
          void post();
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
      for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
      thumbUrls.clear();
      roll = null;
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
      // 📷 A photo that arrived, or one that stopped on its way, shows.
      photoSince += dt;
      if (photoSince >= PHOTO_REFRESH_S) {
        photoSince = 0;
        const key = photoLooks();
        if (key !== photoKey) {
          photoKey = key;
          render();
        }
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
