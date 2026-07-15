/**
 * 👥 Contacts + Friends (keyed-identity, brainstorming/keyed-identity-contacts-plan.md §8)
 *
 * Two tiers over the Ed25519 identity (keypair.ts):
 *  - CONTACTS: verified identities you've exchanged cards with (or, later, the
 *    wide mesh of everyone you've met). Low-intent. A contact is a public key
 *    with a self-signed name — you can VERIFY the name↔key binding.
 *  - FRIENDS: a curated subset you explicitly add. The trust anchors for the
 *    mesh and the boundary for direct messages.
 *
 * A CONTACT CARD is a self-signed credential — `{pub, name, hints?}` signed by
 * the owner's key — shared peer-to-peer over the same `ssf://` carrier as room
 * passes (paste / QR later). Importing verifies the signature client-side
 * (TOFU: proves key ownership, not that the name is a unique real person —
 * always show the fingerprint). `hints` carries the owner's node reachability
 * so a later DM / mesh link can dial them.
 *
 * This list is LOCAL (per-install, localStorage) — your address book, not
 * shared truth. No server, no directory, no third-party infra.
 */

import { getIdentityPub, signIdentity, verifyIdentity, fingerprintOf } from './keypair';

export interface ContactCard {
  v: 1;
  kind: 'contact';
  pub: string;                 // base64url Ed25519 public key
  name: string;
  hints?: unknown;             // reachability (memberHints) for DM / mesh dialing
  /** Self-signed CONSENT to be introduced friend-of-friend in the mesh (§7 M2).
   *  Only a discoverable subject is ever gossiped; the flag travels IN the
   *  signed card so an introducer can prove the subject opted in. */
  discoverable?: boolean;
  issuedAt: number;
  sig: string;                 // base64url self-signature over the canonical bytes
}

export interface Contact {
  pub: string;
  name: string;
  hints?: unknown;
  discoverable?: boolean;
  friend: boolean;
  addedAt: number;
  /** The subject's OWN signature + issuance from their card, retained so we can
   *  reconstruct their verifiable signed card (reconstructCard) — e.g. to prove
   *  their consent when introducing them (§7 M2 receiver-side consent proof). */
  cardIssuedAt?: number;
  cardSig?: string;
}

export interface ContactsDeps {
  /** Our node's current reachability hints to embed in our own card (so peers
   *  can dial us for a DM / mesh link). Null when offline. */
  myHints: () => unknown;
  /** Our display name (identity.getPlayerName). */
  myName: () => string;
}

const STORAGE_KEY = 'ssf-contacts';
let deps: ContactsDeps | null = null;
let contacts: Contact[] = [];
const listeners = new Set<() => void>();

// ── Canonical sign-bytes (domain-tagged + versioned, replay-proof) ───────────

function cardSignBytes(pub: string, name: string, issuedAt: number, hints: unknown, discoverable: boolean): Uint8Array {
  // Stable JSON of the signed fields (hints + discoverable included so a swapped
  // address or forged consent is detected). Explicit key order — no ambiguity.
  const canonical = JSON.stringify({ k: 'ssf-contact-card:v1', pub, name, issuedAt, hints: hints ?? null, discoverable: !!discoverable });
  return new TextEncoder().encode(canonical);
}

const DISCOVERABLE_KEY = 'ssf-discoverable';

/** Whether WE consent to friend-of-friend introduction (default off — opt-in,
 *  the sovereignty-minded default). */
export function isDiscoverable(): boolean {
  try { return localStorage.getItem(DISCOVERABLE_KEY) === '1'; } catch { return false; }
}

export function setDiscoverable(on: boolean): void {
  try { localStorage.setItem(DISCOVERABLE_KEY, on ? '1' : '0'); } catch { /* session-only */ }
  notify();
}

// ── Persistence ──────────────────────────────────────────────────────────────

function load(): Contact[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is Contact =>
        c && typeof c.pub === 'string' && typeof c.name === 'string' && typeof c.friend === 'boolean',
    );
  } catch {
    return [];
  }
}

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts)); } catch { /* session-only */ }
}

function notify(): void {
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[contacts] listener threw:', e); }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initContacts(d: ContactsDeps): void {
  deps = d;
  contacts = load();
  notify();
}

export function listContacts(): Contact[] {
  return contacts.slice();
}

export function listFriends(): Contact[] {
  return contacts.filter((c) => c.friend);
}

export function getContact(pub: string): Contact | undefined {
  return contacts.find((c) => c.pub === pub);
}

export function subscribeContacts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function contactFingerprint(pub: string): string {
  return fingerprintOf(pub);
}

/** Build + sign OUR shareable contact card (identity + current reachability). */
export function myContactCard(): ContactCard {
  const pub = getIdentityPub();
  const name = deps?.myName() ?? 'Clone';
  const hints = deps?.myHints() ?? null;
  const discoverable = isDiscoverable();
  const issuedAt = Date.now();
  const sig = signIdentity(cardSignBytes(pub, name, issuedAt, hints, discoverable));
  return { v: 1, kind: 'contact', pub, name, hints: hints ?? undefined, discoverable, issuedAt, sig };
}

/** Encode our card as an `ssf://contact?card=...` string for sharing. */
export function encodeMyCard(): string {
  const json = JSON.stringify(myContactCard());
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return `ssf://contact?card=${b64}`;
}

/** Parse + VERIFY a pasted contact card (any `ssf://contact?card=` URL or bare
 *  base64/JSON). Returns the validated card, or null if unreadable / bad sig /
 *  wrong self-signer. */
export function decodeContactCard(input: string): ContactCard | null {
  let raw = input.trim();
  const m = raw.match(/[?&]card=([^&\s]+)/);
  if (m) raw = decodeURIComponent(m[1]);
  let card: ContactCard;
  try {
    // Accept raw JSON or base64(JSON).
    const json = raw.startsWith('{') ? raw : decodeURIComponent(escape(atob(raw)));
    card = JSON.parse(json);
  } catch {
    return null;
  }
  return verifyContactCard(card) ? card : null;
}

/** Object-level card verification: shape + the self-signature by the key it
 *  claims. Shared by decodeContactCard and by introduction ingest (so a
 *  vouched subject's card proves identity + consent + route by the subject's
 *  OWN key, not the introducer's word). */
export function verifyContactCard(card: ContactCard | null | undefined): boolean {
  if (
    !card || card.kind !== 'contact' ||
    typeof card.pub !== 'string' || typeof card.name !== 'string' ||
    typeof card.issuedAt !== 'number' || typeof card.sig !== 'string'
  ) return false;
  return verifyIdentity(card.pub, cardSignBytes(card.pub, card.name, card.issuedAt, card.hints ?? null, !!card.discoverable), card.sig);
}

/** Rebuild a contact's verifiable signed card from the retained fields, or null
 *  if we never stored the subject's signature (legacy/self-added contact). */
export function reconstructCard(c: Contact): ContactCard | null {
  if (typeof c.cardSig !== 'string' || typeof c.cardIssuedAt !== 'number') return null;
  const card: ContactCard = {
    v: 1, kind: 'contact', pub: c.pub, name: c.name,
    hints: c.hints, discoverable: !!c.discoverable, issuedAt: c.cardIssuedAt, sig: c.cardSig,
  };
  return verifyContactCard(card) ? card : null;
}

/** Import a verified card → add/refresh the contact. Returns the pub, or an
 *  error. Never marks a contact a friend automatically (that's an explicit
 *  action, or a mutual accept). Importing your OWN card is a no-op. */
export function addContactFromCard(input: string): { ok: true; pub: string; name: string; isSelf: boolean } | { ok: false; error: string } {
  const card = decodeContactCard(input);
  if (!card) return { ok: false, error: 'Invalid or unverifiable contact card.' };
  if (card.pub === getIdentityPub()) return { ok: true, pub: card.pub, name: card.name, isSelf: true };
  const existing = contacts.find((c) => c.pub === card.pub);
  if (existing) {
    existing.name = card.name;               // refresh name
    existing.hints = card.hints;             // refresh reachability
    existing.discoverable = !!card.discoverable; // refresh consent flag
    existing.cardIssuedAt = card.issuedAt;   // retain the subject's own signature
    existing.cardSig = card.sig;             // so we can prove their consent later
  } else {
    contacts.push({
      pub: card.pub, name: card.name, hints: card.hints, discoverable: !!card.discoverable,
      friend: false, addedAt: Date.now(), cardIssuedAt: card.issuedAt, cardSig: card.sig,
    });
  }
  persist();
  notify();
  return { ok: true, pub: card.pub, name: card.name, isSelf: false };
}

/** Add/remove a contact from the FRIENDS tier (curated). v1 is one-sided (a
 *  mutual signed accept-handshake is a refinement) — a friend you added can
 *  DM you once they've added you back and you're both reachable. */
export function setFriend(pub: string, friend: boolean): void {
  const c = contacts.find((x) => x.pub === pub);
  if (c && c.friend !== friend) { c.friend = friend; persist(); notify(); }
}

export function removeContact(pub: string): void {
  contacts = contacts.filter((c) => c.pub !== pub);
  persist();
  notify();
}
