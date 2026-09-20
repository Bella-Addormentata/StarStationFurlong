/**
 * 🎉 Focused UIs for the party props — the cake, a gift box, the speaker.
 *
 * These are ordinary DeviceUIs (devices.ts DeviceUI): the avatar walks to the
 * prop's `front`, the camera eases in, and this panel mounts. They are small on
 * purpose — a party prop should answer one question and get out of the way.
 *
 * THE RULE THAT MATTERS, and the reason the cake has a UI at all: a guest who
 * clicks the lit cake must be TOLD it is not their candle to blow. A click that
 * does nothing reads as a broken prop; a click that answers reads as a rule,
 * and the rule is what makes one avatar the guest of honour.
 *
 * All state changes go through partyDoc — never a local flag — so the moment
 * lands on every screen at the same time. This module only renders and asks.
 */

import type { DeviceUI } from './devices';
import {
  readCake, blowCandles, relightCandles,
  readGift, openGift, closeGift,
  readSpeaker, toggleSpeaker,
  readBirthdayPub, setBirthdayPub,
  subscribeParty,
  cakeKey, giftKey, speakerKey,
} from './partyDoc';

const GOLD = '#d4a84b';
const GOLD_BRIGHT = '#F0C060';
const DIM = '#4A5560';
const GREEN = '#2fe6a0';
const WARN = '#ff8a50';

/** Text escape for names that came off the wire (a peer picks their own). */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface PartyDeviceDeps {
  itemId: string;
  /** This client's identity pubkey (base64url) — the birthday gate's subject. */
  myPub: () => string;
  /** This client's display name, for the "opened by" line. */
  myName: () => string;
  /** Display name for a pubkey (room players first, then contacts). */
  nameForPub: (pub: string) => string;
  /** Room-owner gate — who may name the guest of honour and re-light. */
  canEdit: () => boolean;
  /** Candidates for the honouree picker: everyone the host could mean. */
  honourees: () => Array<{ pub: string; name: string }>;
  /** 🍰 Hand the player a slice once the candles are out (arm pose + hint). */
  onSlice?: () => void;
}

const PANEL_CSS = `
  position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%);
  width: 300px; max-height: 90vh; overflow-y: auto;
  background: rgba(4, 8, 22, 0.94); border: 1px solid rgba(212, 168, 75, 0.28);
  border-radius: 12px; box-shadow: 0 12px 64px rgba(0,0,0,0.9);
  padding: 18px; display: flex; flex-direction: column; gap: 12px;
  color: ${GOLD}; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  box-sizing: border-box; pointer-events: auto;
`;

function bigButton(attr: string, label: string, tone: string, enabled = true): string {
  return `<button ${attr} ${enabled ? '' : 'disabled'} style="
    display:flex; justify-content:center; align-items:center;
    padding:11px 12px; width:100%;
    background:${enabled ? `rgba(${tone},0.14)` : 'rgba(212,168,75,0.05)'};
    border:1px solid ${enabled ? `rgba(${tone},0.75)` : 'rgba(212,168,75,0.2)'};
    border-radius:7px; color:${enabled ? GOLD_BRIGHT : DIM};
    font-family:inherit; font-size:12px; font-weight:800; letter-spacing:0.5px;
    cursor:${enabled ? 'pointer' : 'default'};
  ">${label}</button>`;
}

function title(text: string, sub: string): string {
  return `<div>
    <div style="font-size:13px; font-weight:800; letter-spacing:1px; color:${GOLD_BRIGHT};">${text}</div>
    <div style="font-size:10px; color:${DIM}; margin-top:3px;">${sub}</div>
  </div>`;
}

/** Shared mount/unmount shell — every party panel has the same lifecycle. */
function panelUI(
  id: string,
  render: (panel: HTMLDivElement) => void,
): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;
  const repaint = (): void => {
    if (panel) render(panel);
  };
  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = id;
      panel.style.cssText = PANEL_CSS;
      panel.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(panel);
      // Repaint on ANY party write: a peer blowing the candles must update the
      // panel I am standing in front of.
      unsubscribe = subscribeParty(repaint);
      repaint();
    },
    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      panel?.remove();
      panel = null;
    },
    update(): void {
      /* doc-driven — nothing to tween */
    },
  };
}

// ── 🎂 The cake ──────────────────────────────────────────────────────────────

export function createCakeTableUI(deps: PartyDeviceDeps): DeviceUI {
  return panelUI(`device-cake-${deps.itemId}`, (panel) => {
    const cake = readCake(deps.itemId);
    const birthday = readBirthdayPub();
    const me = deps.myPub();
    const iAmHonouree = birthday !== '' && birthday === me;
    const honoureeName = birthday ? deps.nameForPub(birthday) : '';
    const owner = deps.canEdit();

    let body: string;
    if (cake.lit && birthday === '') {
      body = `<div style="font-size:11px; color:${WARN}; line-height:1.5;">
        Nobody is the guest of honour yet.${owner ? ' Name one below — the candles are theirs to blow.' : ' Ask the host to name one.'}
      </div>`;
    } else if (cake.lit && iAmHonouree) {
      body = `<div style="font-size:11px; line-height:1.5;">The candles are yours. Everyone is waiting.</div>
        ${bigButton('data-blow="1"', '🕯 BLOW OUT THE CANDLES', '255,179,0')}`;
    } else if (cake.lit) {
      // THE REFUSAL THAT READS AS A RULE — never an inert button.
      body = `<div style="font-size:11px; line-height:1.5; color:${GOLD};">
        🕯 Waiting for <b style="color:${GOLD_BRIGHT};">${esc(honoureeName || 'the guest of honour')}</b> to blow out the candles!
      </div>`;
    } else {
      body = `<div style="font-size:11px; line-height:1.5; color:${GREEN};">🎉 The candles are out — help yourself.</div>
        ${bigButton('data-slice="1"', '🍰 TAKE A SLICE', '47,230,160')}`;
    }

    // The host's controls: name the honouree, and reset for the next party.
    let hostBlock = '';
    if (owner) {
      const options = deps
        .honourees()
        .map(
          (h) =>
            `<option value="${esc(h.pub)}"${h.pub === birthday ? ' selected' : ''}>${esc(h.name)}</option>`,
        )
        .join('');
      hostBlock = `
        <div style="border-top:1px solid rgba(212,168,75,0.12); padding-top:10px; display:flex; flex-direction:column; gap:8px;">
          <div style="font-size:9px; color:${DIM}; letter-spacing:1.5px;">HOST — GUEST OF HONOUR</div>
          <select data-honouree="1" style="
            width:100%; background:rgba(0,0,0,0.35); border:1px solid rgba(212,168,75,0.3);
            border-radius:5px; color:${GOLD_BRIGHT}; font-family:inherit; font-size:11px; padding:5px 6px;">
            <option value=""${birthday === '' ? ' selected' : ''}>— nobody —</option>
            ${options}
          </select>
          ${cake.lit ? '' : bigButton('data-relight="1"', '🕯 RE-LIGHT THE CANDLES', '212,168,75')}
        </div>`;
    }

    panel.innerHTML = `
      ${title('🎂 THE CAKE', cake.lit ? `${cake.candles} candles, lit` : 'candles out')}
      ${body}
      ${hostBlock}
    `;

    panel.querySelector<HTMLButtonElement>('[data-blow]')?.addEventListener('click', () => {
      const result = blowCandles(deps.itemId, me, honoureeName);
      // A refused blow still has to say why — the same sentence a guest sees.
      if (!result.ok) showPanelNote(panel, result.error);
    });
    panel.querySelector<HTMLButtonElement>('[data-slice]')?.addEventListener('click', () => {
      deps.onSlice?.();
    });
    panel.querySelector<HTMLButtonElement>('[data-relight]')?.addEventListener('click', () => {
      if (deps.canEdit()) relightCandles(deps.itemId, cake.candles);
    });
    panel.querySelector<HTMLSelectElement>('[data-honouree]')?.addEventListener('change', (e) => {
      if (deps.canEdit()) setBirthdayPub((e.target as HTMLSelectElement).value);
    });
  });
}

/** A transient line under the panel body (refusals, confirmations). */
function showPanelNote(panel: HTMLDivElement, text: string): void {
  let note = panel.querySelector<HTMLDivElement>('.party-note');
  if (!note) {
    note = document.createElement('div');
    note.className = 'party-note';
    note.style.cssText = `font-size:10px; color:${WARN}; line-height:1.4;`;
    panel.appendChild(note);
  }
  note.textContent = text;
}

// ── 🎁 Gifts ─────────────────────────────────────────────────────────────────

export function createGiftBoxUI(deps: PartyDeviceDeps): DeviceUI {
  return panelUI(`device-gift-${deps.itemId}`, (panel) => {
    const gift = readGift(deps.itemId);
    const owner = deps.canEdit();
    panel.innerHTML = `
      ${title('🎁 A PRESENT', gift.opened ? 'opened' : 'still wrapped')}
      ${
        gift.opened
          ? `<div style="font-size:11px; color:${GREEN}; line-height:1.5;">
               Opened by <b>${esc(gift.byName || 'someone')}</b>.
             </div>
             ${owner ? bigButton('data-rewrap="1"', '🎀 WRAP IT AGAIN', '212,168,75') : ''}`
          : bigButton('data-open="1"', '🎁 OPEN IT', '255,143,171')
      }
    `;
    panel.querySelector<HTMLButtonElement>('[data-open]')?.addEventListener('click', () => {
      const result = openGift(deps.itemId, deps.myName());
      if (!result.ok) showPanelNote(panel, result.error);
    });
    panel.querySelector<HTMLButtonElement>('[data-rewrap]')?.addEventListener('click', () => {
      if (deps.canEdit()) closeGift(deps.itemId);
    });
  });
}

// ── 🔊 The speaker ───────────────────────────────────────────────────────────

export function createPartySpeakerUI(deps: PartyDeviceDeps): DeviceUI {
  return panelUI(`device-speaker-${deps.itemId}`, (panel) => {
    const { on } = readSpeaker(deps.itemId);
    panel.innerHTML = `
      ${title('🔊 PARTY SPEAKER', on ? 'playing — the floor is lit' : 'silent')}
      ${bigButton('data-toggle="1"', on ? '⏸ STOP THE MUSIC' : '▶ START THE MUSIC', on ? '255,138,80' : '47,230,160')}
      <div style="font-size:10px; color:${DIM}; line-height:1.4;">
        Drives every dance floor in this room.
      </div>
    `;
    panel.querySelector<HTMLButtonElement>('[data-toggle]')?.addEventListener('click', () => {
      toggleSpeaker(deps.itemId);
    });
  });
}

// Re-exported so world.ts can subscribe to a single prop's key if it ever needs
// to without importing partyDoc twice.
export { cakeKey, giftKey, speakerKey };
