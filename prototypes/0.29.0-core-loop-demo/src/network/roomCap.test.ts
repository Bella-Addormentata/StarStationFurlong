import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ed from '@noble/ed25519';
import {
  MAX_CAP_MEMBER_CARDS,
  NODE_CARD_KEY,
  acceptNodeCard,
  bridgeMemberHints,
  buildRoomCapPayload,
  cardsForPass,
  collectMemberHints,
  contactCardSignBytes,
  forgetSessionFlags,
  latin1Json,
  seedWithoutCards,
  memberCardsOf,
  mergeMemberHints,
  newerCard,
  nextCapSeq,
  nodeSharesCard,
  normalizeContactCard,
  normalizeMemberHint,
  passageReading,
  readChiaMode,
  readNodeCard,
  readShareCard,
  roomIsPublicSpace,
  roomPosture,
  roomPostureProbe,
  routeHint,
  setChiaMode,
  setShareCard,
  type PostureSources,
  verifyContactCard,
} from './roomCap';

const card = (nodeId: string, issuedAt = 100) => ({ nodeId, ck: 'Y2s=', kxPk: 'ab', issuedAt, sig: 'ff' });

// A node per name, its id the hex Ed25519 key, and cards it signs (round 16:
// a hint's card rides only verified, so the merge fixtures are signed).
const keyOf = new Map<string, Uint8Array>();
const nodeOf = (name: string) => {
  let sk = keyOf.get(name);
  if (!sk) { sk = ed.utils.randomPrivateKey(); keyOf.set(name, sk); }
  return ed.etc.bytesToHex(ed.getPublicKey(sk));
};
const ck32 = (b: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(b)));
const signed = (name: string, issuedAt = 100, ckByte = 7) => {
  const c = { nodeId: nodeOf(name), ck: ck32(ckByte), kxPk: 'ab'.repeat(32), issuedAt };
  return { ...c, sig: ed.etc.bytesToHex(ed.sign(contactCardSignBytes(c), keyOf.get(name)!)) };
};

describe('room cap payload (N8 / D3)', () => {
  it('carries the key, both flags coerced to booleans, and the sequence number', () => {
    expect(buildRoomCapPayload('k', true, false, 7)).toEqual({ roomKeyB64: 'k', chiaMode: true, publicRoom: false, seq: 7, shareCard: true });
    expect(buildRoomCapPayload('k', 0 as unknown as boolean, 1 as unknown as boolean, 2.9)).toEqual({
      roomKeyB64: 'k',
      chiaMode: false,
      publicRoom: true,
      seq: 2,
      shareCard: true,
    });
    expect(buildRoomCapPayload('k', true, true, Number.NaN).seq).toBe(0);
  });

  it('P6b: carries the share toggle, and member cards only for a private room, capped', () => {
    expect(buildRoomCapPayload('k', false, false, 1, false).shareCard).toBe(false);
    expect(buildRoomCapPayload('k', false, false, 1, undefined as unknown as boolean).shareCard).toBe(true);
    const cards = [card('a'), card('b')];
    expect(buildRoomCapPayload('k', false, false, 1, true, cards).memberCards).toEqual(cards);
    expect(buildRoomCapPayload('k', false, true, 1, true, cards).memberCards).toBeUndefined();
    expect(buildRoomCapPayload('k', false, false, 1, true, []).memberCards).toBeUndefined();
    const many = Array.from({ length: MAX_CAP_MEMBER_CARDS + 5 }, (_, i) => card(`n${i}`));
    expect(buildRoomCapPayload('k', false, false, 1, true, many).memberCards).toHaveLength(MAX_CAP_MEMBER_CARDS);
  });

  it('P6b: a contact card needs every field with its type; the newer of two wins', () => {
    expect(normalizeContactCard(card('a', 5.7))).toEqual({ ...card('a', 5) });
    expect(normalizeContactCard({ ...card('a'), ck: '' })).toBeNull();
    expect(normalizeContactCard({ ...card('a'), issuedAt: '100' })).toBeNull();
    expect(normalizeContactCard({ ...card('a'), issuedAt: -1 })).toBeNull();
    // A timestamp the node cannot read as a u64 leaves the card out — not the cap (round 13).
    expect(normalizeContactCard({ ...card('a'), issuedAt: 1e100 })).toBeNull();
    expect(normalizeContactCard({ ...card('a'), issuedAt: 2 ** 53 })).toBeNull();
    expect(normalizeContactCard({ ...card('a'), issuedAt: Number.POSITIVE_INFINITY })).toBeNull();
    expect(normalizeContactCard({ ...card('a'), issuedAt: Number.NaN })).toBeNull();
    expect(normalizeContactCard({ ...card('a'), issuedAt: Number.MAX_SAFE_INTEGER })).toEqual(card('a', Number.MAX_SAFE_INTEGER));
    expect(normalizeContactCard({ ...card('a'), issuedAt: 0 })).toEqual(card('a', 0));
    expect(normalizeContactCard({ ...card('a'), sig: undefined })).toBeNull();
    expect(normalizeContactCard(null)).toBeNull();
    expect(normalizeContactCard('card')).toBeNull();
    expect(newerCard(card('a', 1), card('a', 2))).toEqual(card('a', 2));
    expect(newerCard(card('a', 3), card('a', 2))).toEqual(card('a', 3));
    expect(newerCard(undefined, card('a'))).toEqual(card('a'));
    expect(newerCard(card('a'), undefined)).toEqual(card('a'));
  });

  it('P6b: the cap takes each hint\'s card once, only when it names the hint\'s node', () => {
    const hints = [
      { irohNodeId: 'a', nodeCard: card('a') },
      { irohNodeId: 'b' },
      { irohNodeId: 'c', nodeCard: card('x') },
      { irohNodeId: 'a', nodeCard: card('a', 200) },
      { irohNodeId: 'd', nodeCard: { nodeId: 'd' } as never },
      { irohNodeId: 'e', nodeCard: card('e', 1e100) },
    ];
    expect(memberCardsOf(hints)).toEqual([card('a')]);
    // One malformed card leaves the roster, never the cap: the key, the
    // posture and the rest of the cards still go (round 13).
    expect(buildRoomCapPayload('k', false, false, 1, true, memberCardsOf(hints))).toMatchObject({ roomKeyB64: 'k', memberCards: [card('a')], passPrivate: true });
    expect(memberCardsOf(undefined)).toEqual([]);
  });

  it('P6b: a pass carries no card in a public room, and not ours while Share Card is off', () => {
    const hints = [
      { irohNodeId: 'me', nodeCard: card('me') },
      { irohNodeId: 'them', nodeCard: card('them') },
      { irohNodeId: 'bare' },
    ];
    expect(cardsForPass(hints, true, true, 'me').map((h) => h.nodeCard)).toEqual([undefined, undefined, undefined]);
    expect(cardsForPass(hints, false, true, 'me')).toEqual(hints);
    // The switch is off for this room: our own card stays home, the others
    // (shared into this room by their owners) still ride.
    const off = cardsForPass(hints, false, false, 'me');
    expect(off).toEqual([{ irohNodeId: 'me' }, { irohNodeId: 'them', nodeCard: card('them') }, { irohNodeId: 'bare' }]);
    expect(cardsForPass(hints, false, false, undefined)).toEqual(hints);
    expect(hints[0].nodeCard).toEqual(card('me'));
  });

  it('P6b: the cap says UNKNOWN (null) until the door docs are bound, and a private pass\'s cards ride with passPrivate', () => {
    // #272 review round 3: a first visit by a private pass, no room document
    // yet — the cap says "not known" rather than PUBLIC, and carries the
    // pass's cards with the pass's word, so the node can knock on the host
    // when every live route fails; the pass MINTER still treats unknown as
    // public (roomIsPublicSpace) and carries no card.
    expect(roomPosture(true, undefined)).toBe(true);
    expect(roomPosture(true, false)).toBe(true);
    expect(roomPosture(false, true)).toBe(true);
    expect(roomPosture(false, false)).toBe(false);
    expect(roomPosture(false, undefined)).toBeUndefined();
    const cards = [card('host')];
    const firstVisit = buildRoomCapPayload('k', false, undefined, 1, true, cards);
    expect(firstVisit.publicRoom).toBeNull();
    expect(firstVisit.memberCards).toEqual(cards);
    expect(firstVisit.passPrivate).toBe(true);
    expect(buildRoomCapPayload('k', false, null, 1, true, []).passPrivate).toBeUndefined();
    expect(buildRoomCapPayload('k', false, true, 1, true, cards)).toEqual({ roomKeyB64: 'k', chiaMode: false, publicRoom: true, seq: 1, shareCard: true });
    expect(buildRoomCapPayload('k', false, false, 1, true, cards).passPrivate).toBe(true);
  });

  it("P6b: a pass prefetch's cap says UNKNOWN whatever it was told, arms nothing and carries the pass's cards", () => {
    // #272 review round 9: USE PASS warms a room on a provider with no posture
    // probe; its cap must let the node use the pass's cards (knock on a host
    // every live route fails to reach) without claiming a posture, arming
    // publishing or sharing our own card.
    const cards = [card('host')];
    expect(buildRoomCapPayload('k', true, false, 3, true, cards, true)).toEqual({
      roomKeyB64: 'k', chiaMode: false, publicRoom: null, seq: 3, shareCard: true, prefetch: true, memberCards: cards, passPrivate: true,
    });
    expect(buildRoomCapPayload('k', true, true, 3, false, [], true)).toEqual({ roomKeyB64: 'k', chiaMode: false, publicRoom: null, seq: 3, shareCard: false, prefetch: true });
    expect(buildRoomCapPayload('k', true, false, 3, true, cards)).toMatchObject({ chiaMode: true, publicRoom: false });
    expect(buildRoomCapPayload('k', true, false, 3, true, cards).prefetch).toBeUndefined();
  });

  it('P6b: a first visit\'s cap says UNKNOWN until the room\'s state is usable, then what its doors say', () => {
    // #272 review round 4: the whole first-visit sequence. The door documents
    // are bound right after the sync starts, while the replica is still EMPTY
    // — and empty door documents read as the cardinal defaults, which are
    // public. Read then, the cap would say PUBLIC and the node would stop
    // using the private pass's cards before the host's state could land.
    const state = { docsBoundFor: null as string | null, stateUsable: false, passagePublic: true };
    const src: PostureSources = {
      bundled: (roomId) => roomId === 'welcome',
      docsBoundFor: () => state.docsBoundFor,
      stateUsable: () => state.stateUsable,
      passagePublic: () => state.passagePublic,
    };
    const probe = roomPostureProbe(src);
    const cards = [card('host')];
    const cap = () => buildRoomCapPayload('k', false, probe('r'), 1, true, cards);
    // 1. connect: no door documents are bound yet.
    expect(cap()).toMatchObject({ publicRoom: null, passPrivate: true, memberCards: cards });
    expect(roomIsPublicSpace(src.bundled('r'), passageReading(src, 'r'))).toBe(true); // a pass minted now carries no card
    // 2. the room's documents are bound, the replica is empty: its defaults
    //    read public, which is no reading at all.
    state.docsBoundFor = 'r';
    expect(passageReading(src, 'r')).toBeUndefined();
    expect(cap()).toMatchObject({ publicRoom: null, passPrivate: true, memberCards: cards });
    // 3. the host's state lands (or a kept replica seeded it): its doors speak.
    state.stateUsable = true;
    state.passagePublic = false;
    expect(cap()).toMatchObject({ publicRoom: false, passPrivate: true, memberCards: cards });
    expect(roomIsPublicSpace(src.bundled('r'), passageReading(src, 'r'))).toBe(false);
    state.passagePublic = true;
    expect(cap()).toEqual({ roomKeyB64: 'k', chiaMode: false, publicRoom: true, seq: 1, shareCard: true });
    // Another room's documents bound say nothing about this one; the bundled
    // room is public whatever is bound or synced.
    state.docsBoundFor = 'other';
    expect(probe('r')).toBeUndefined();
    expect(probe('welcome')).toBe(true);
  });

  it('P6b: a switch flipped while storage refuses the write still holds for the cap and the pass', () => {
    // #272 review round 6: Share Card OFF in a browser whose localStorage
    // throws on write (privacy mode, a full quota) used to update the panel
    // alone: the cap and the pass builders read storage, which still said ON.
    const kept = new Map<string, string>();
    const refusing = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (k: string) => void kept.delete(k),
      clear: () => kept.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { value: refusing, configurable: true, writable: true });
    try {
      forgetSessionFlags();
      kept.set('ssf-chia-share-card-r', '1'); // a stored ON from an earlier session
      expect(readShareCard('r')).toBe(true);
      setShareCard('r', false);
      expect(kept.get('ssf-chia-share-card-r')).toBe('1'); // the write was refused…
      expect(readShareCard('r')).toBe(false); // …and the choice holds all the same
      // The cap the node reads, and the pass a member is handed, both see OFF.
      expect(buildRoomCapPayload('k', false, false, 1, readShareCard('r'), [card('host')]).shareCard).toBe(false);
      const hints = [{ irohNodeId: 'me', nodeCard: card('me') }, { irohNodeId: 'host', nodeCard: card('host') }];
      const pass = cardsForPass(hints, false, readShareCard('r'), 'me');
      expect(pass[0].nodeCard).toBeUndefined();
      expect(pass[1].nodeCard).toEqual(card('host'));
      setShareCard('r', true);
      expect(readShareCard('r')).toBe(true);
      // Another room is untouched; the Chia Mesh switch works the same way.
      expect(readShareCard('s')).toBe(true);
      expect(readChiaMode('r')).toBe(false);
      setChiaMode('r', true);
      expect(readChiaMode('r')).toBe(true);
      setChiaMode('r', false);
      expect(readChiaMode('r')).toBe(false);
      // A browser that allows the write persists it too.
      refusing.setItem = (k: string, v: string) => void kept.set(k, v);
      setShareCard('t', false);
      expect(kept.get('ssf-chia-share-card-t')).toBe('0');
    } finally {
      forgetSessionFlags();
      if (had) Object.defineProperty(globalThis, 'localStorage', had);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it("P6b: a switch stored successfully is read back from storage, so another tab's later word is seen", () => {
    // #272 review round 7: the session copy a refused write leaves behind must
    // not outlive a write that WORKED — tab A's ON would hide the OFF tab B
    // stored afterwards, and A would hand our card out on its next pass.
    const kept = new Map<string, string>();
    const storage = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
      clear: () => kept.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
    try {
      forgetSessionFlags();
      setShareCard('r', true);
      expect(kept.get('ssf-chia-share-card-r')).toBe('1');
      kept.set('ssf-chia-share-card-r', '0'); // another tab turned it off
      expect(readShareCard('r')).toBe(false);
      setChiaMode('r', true);
      kept.set('ssf-chia-mode-r', '0');
      expect(readChiaMode('r')).toBe(false);
      // A refused write still holds for this tab…
      storage.setItem = () => {
        throw new Error('QuotaExceededError');
      };
      setShareCard('r', true);
      expect(kept.get('ssf-chia-share-card-r')).toBe('0');
      expect(readShareCard('r')).toBe(true);
      // …until a write works again, after which storage speaks.
      storage.setItem = (k: string, v: string) => void kept.set(k, v);
      setShareCard('r', false);
      expect(kept.get('ssf-chia-share-card-r')).toBe('0');
      kept.set('ssf-chia-share-card-r', '1');
      expect(readShareCard('r')).toBe(true);
    } finally {
      forgetSessionFlags();
      if (had) Object.defineProperty(globalThis, 'localStorage', had);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it('P6b: the personal contact card carries the route alone, never the node card', () => {
    // #272 review round 7: a contact card goes wherever the player pastes it
    // and, with consent, on through friend-of-friend introductions, outside
    // any room; our node's card is handed out in a private room's pass alone.
    const hint = { irohNodeId: 'me', irohRelayUrls: ['https://relay'], irohDirectAddrs: ['198.51.100.7:4444'], nodeCard: card('me') };
    expect(routeHint(hint)).toEqual({ irohNodeId: 'me', irohRelayUrls: ['https://relay'], irohDirectAddrs: ['198.51.100.7:4444'] });
    expect('nodeCard' in routeHint(hint)).toBe(false);
    expect(routeHint({ irohNodeId: 'bare' })).toEqual({ irohNodeId: 'bare' });
    // And main.ts hands the contacts module that route, not the pass hint.
    const main = readFileSync(fileURLToPath(new URL('../main.ts', import.meta.url)), 'utf8');
    const at = main.indexOf('initContacts({');
    expect(at).toBeGreaterThan(0);
    const block = main.slice(at, main.indexOf('});', at));
    expect(block).toContain('routeHint(');
  });

  it('P6b: a node that hands out no card keeps the cached one out of every pass', () => {
    // #272 review round 3: the node restarted with SSF_CHIA_SHARE_CARD=0; the
    // browser still holds the card it was handed before.
    expect(nodeSharesCard({ share_card: false })).toBe(false);
    expect(nodeSharesCard({ share_card: true })).toBe(true);
    expect(nodeSharesCard({})).toBe(true);
    expect(nodeSharesCard(null)).toBe(true);
    const hints = [
      { irohNodeId: 'me', nodeCard: card('me') },
      { irohNodeId: 'them', nodeCard: card('them') },
    ];
    const roomSwitch = true;
    expect(cardsForPass(hints, false, roomSwitch && nodeSharesCard({ share_card: false }), 'me')).toEqual([
      { irohNodeId: 'me' },
      { irohNodeId: 'them', nodeCard: card('them') },
    ]);
    expect(cardsForPass(hints, false, roomSwitch && nodeSharesCard({ share_card: true }), 'me')).toEqual(hints);
  });

  it('strikes every node card from a pass seed bound for a public audience, and leaves other seeds alone', () => {
    // #272 review round 11: the atlas publishes a public room's stored seed
    // into the room doc; one minted while the room was private carries cards.
    const boot = {
      v: 2, roomId: 'r', roomKeyB64: 'a2V5', wtUrl: '', certHashesB64: ['c'],
      memberHints: [
        { irohNodeId: 'me', irohRelayUrls: ['https://relay'], nodeCard: card('me') },
        { irohNodeId: 'them', nodeCard: card('them') },
        { irohNodeId: 'bare' },
      ],
      issuedAt: 5,
    };
    const routes = [{ irohNodeId: 'me', irohRelayUrls: ['https://relay'] }, { irohNodeId: 'them' }, { irohNodeId: 'bare' }];
    const seed = btoa(JSON.stringify(boot));
    expect(JSON.parse(atob(seedWithoutCards(seed)))).toEqual({ ...boot, memberHints: routes });
    // In a pass URL's seed param, bare scheme or http: the other params stay.
    const asUrl = seedWithoutCards(`ssf://room?seed=${encodeURIComponent(seed)}`);
    expect(asUrl.startsWith('ssf://room?seed=')).toBe(true);
    expect(JSON.parse(atob(new URL(asUrl).searchParams.get('seed')!)).memberHints).toEqual(routes);
    const http = new URL(seedWithoutCards(`https://station.example/play?x=1&seed=${encodeURIComponent(seed)}`));
    expect(http.searchParams.get('x')).toBe('1');
    expect(JSON.parse(atob(http.searchParams.get('seed')!)).memberHints).toEqual(routes);
    // Nothing to strike: returned as it is, byte for byte.
    const cardless = btoa(JSON.stringify({ ...boot, memberHints: [{ irohNodeId: 'bare' }] }));
    expect(seedWithoutCards(cardless)).toBe(cardless);
    const cardlessUrl = `ssf://room?seed=${encodeURIComponent(cardless)}`;
    expect(seedWithoutCards(cardlessUrl)).toBe(cardlessUrl);
    expect(seedWithoutCards('ssf://room?seed=welcome')).toBe('ssf://room?seed=welcome');
    expect(seedWithoutCards('#room=module-hub')).toBe('#room=module-hub');
    expect(seedWithoutCards(btoa('not json'))).toBe(btoa('not json'));
    expect(seedWithoutCards(btoa('[1,2]'))).toBe(btoa('[1,2]'));
  });

  it('re-encodes a seed whose JSON spells a character beyond Latin-1, bare or in a pass URL (review round 13)', () => {
    // A seed is base64 of JSON, and JSON may spell any character as \uXXXX:
    // parsed, the character is real, and `btoa` takes Latin-1 alone. The
    // stripped seed spells it the same way and reads back the same — and is
    // never handed back with its cards.
    const relay = 'https://relay/\u{1F680}';
    const boot = {
      v: 2, roomId: 'r', roomKeyB64: 'a2V5', wtUrl: 'wss://\u0100.example/ssf', certHashesB64: ['c'],
      memberHints: [{ irohNodeId: 'me', irohRelayUrls: [relay], nodeCard: card('me') }, { irohNodeId: 'them', nodeCard: card('them') }],
      issuedAt: 5,
    };
    const routes = [{ irohNodeId: 'me', irohRelayUrls: [relay] }, { irohNodeId: 'them' }];
    expect(() => btoa(JSON.stringify(boot))).toThrow();
    expect(latin1Json({ a: '\u0100\u{1F680}' })).toBe('{"a":"\\u0100\\ud83d\\ude80"}');
    const seed = btoa(latin1Json(boot));
    expect(JSON.parse(atob(seedWithoutCards(seed)))).toEqual({ ...boot, memberHints: routes });
    const url = new URL(seedWithoutCards(`ssf://room?seed=${encodeURIComponent(seed)}`));
    expect(JSON.parse(atob(url.searchParams.get('seed')!))).toEqual({ ...boot, memberHints: routes });
  });

  it('P6b: a bridged join adds our route to a pass, never our card, so a cardless public pass stays cardless (review round 14)', () => {
    const me = nodeOf('me'), host = nodeOf('host');
    // Standing in private room A with Share Card on: our default bootstrap carries our card.
    const local = {
      v: 2 as const, roomId: 'A', roomKeyB64: 'a2V5', wtUrl: 'https://127.0.0.1:4443', certHashesB64: ['c'],
      memberHints: [{ irohNodeId: me, irohRelayUrls: ['https://relay-a'], nodeCard: signed('me') }],
      irohNodeId: me, irohRelayUrls: ['https://relay-a'],
    };
    // A pass to public room B carries routes alone (its minter struck the cards).
    const publicPass = {
      v: 2 as const, roomId: 'B', roomKeyB64: 'Yg==', wtUrl: 'https://127.0.0.1:4443', certHashesB64: [],
      memberHints: [{ irohNodeId: host, irohRelayUrls: ['https://relay-b'] }],
    };
    const bridged = bridgeMemberHints(publicPass, local);
    expect(bridged).toEqual([{ irohNodeId: host, irohRelayUrls: ['https://relay-b'] }, { irohNodeId: me, irohRelayUrls: ['https://relay-a'] }]);
    expect(memberCardsOf(bridged)).toEqual([]);
    // Neither the prefetch's cap nor the first cap of the join, posture unknown, calls B's pass private.
    expect(buildRoomCapPayload('Yg==', false, null, 1, true, memberCardsOf(bridged), true))
      .toEqual({ roomKeyB64: 'Yg==', chiaMode: false, publicRoom: null, seq: 1, shareCard: true, prefetch: true });
    expect(buildRoomCapPayload('Yg==', false, null, 2, true, memberCardsOf(bridged))).not.toHaveProperty('passPrivate');
    // A private pass keeps every card it carries — one for our own node included, as its minter put it there.
    const privatePass = { ...publicPass, roomId: 'C', memberHints: [{ irohNodeId: host, nodeCard: signed('host') }, { irohNodeId: me, nodeCard: signed('me', 50) }] };
    const kept = bridgeMemberHints(privatePass, local);
    expect(memberCardsOf(kept)).toEqual([signed('host'), signed('me', 50)]);
    expect(kept.find((h) => h.irohNodeId === me)).toEqual({ irohNodeId: me, irohRelayUrls: ['https://relay-a'], nodeCard: signed('me', 50) });
    expect(buildRoomCapPayload('Yw==', false, null, 3, true, memberCardsOf(kept), true)).toMatchObject({ memberCards: [signed('host'), signed('me', 50)], passPrivate: true });
  });

  it("P6b: a pass's card rides only verified, so a forged card for our node never displaces the genuine one in the passes minted here (review round 16)", () => {
    const me = nodeOf('me'), host = nodeOf('host');
    const genuine = signed('me', 1_000);
    // A pass whose minter put a forgery in for us: our id, the end of time, no valid signature.
    const forged = { ...genuine, issuedAt: Number.MAX_SAFE_INTEGER, sig: 'ff'.repeat(64) };
    const pass = {
      v: 2 as const, roomId: 'C', roomKeyB64: 'Yw==', wtUrl: 'https://127.0.0.1:4443', certHashesB64: [],
      memberHints: [{ irohNodeId: host, irohRelayUrls: ['https://relay-c'], nodeCard: signed('host') }, { irohNodeId: me, irohRelayUrls: ['https://relay-me'], nodeCard: forged }],
    };
    // Normalized, the forged card is gone and the route stays; a card naming another node goes too.
    expect(normalizeMemberHint(pass.memberHints[1])).toEqual({ irohNodeId: me, irohRelayUrls: ['https://relay-me'] });
    expect(normalizeMemberHint({ irohNodeId: me, nodeCard: signed('host') })).toEqual({ irohNodeId: me });
    expect(normalizeMemberHint({ irohNodeId: host, nodeCard: signed('host') })).toEqual({ irohNodeId: host, nodeCard: signed('host') });
    // The outgoing pass: our verified local card first, the imported hints after it (buildOutgoingBootstrap).
    const localHint = { irohNodeId: me, irohRelayUrls: ['https://relay-a'], nodeCard: genuine };
    const merged = mergeMemberHints([localHint], collectMemberHints(pass));
    expect(merged.find((h) => h.irohNodeId === me)).toEqual({ irohNodeId: me, irohRelayUrls: ['https://relay-a', 'https://relay-me'], nodeCard: genuine });
    expect(memberCardsOf(merged)).toEqual([genuine, signed('host')]);
    // A pass carrying a NEWER genuine card for us still wins the merge: dates compare between verified cards.
    const rotated = signed('me', 2_000, 8);
    const newerPass = { ...pass, memberHints: [{ irohNodeId: me, nodeCard: rotated }] };
    expect(mergeMemberHints([localHint], collectMemberHints(newerPass))[0].nodeCard).toEqual(rotated);
    // The cache answers the same way the verification did.
    expect(verifyContactCard(forged)).toBe(false);
    expect(verifyContactCard(genuine)).toBe(true);
  });

  it("P6b: the node's own card is kept only with a valid signature by the node it names (review round 15)", () => {
    const sk = ed.utils.randomPrivateKey();
    const nodeId = ed.etc.bytesToHex(ed.getPublicKey(sk));
    const sign = (c: { nodeId: string; ck: string; kxPk: string; issuedAt: number }) =>
      ({ ...c, sig: ed.etc.bytesToHex(ed.sign(contactCardSignBytes(c), sk)) });
    const ck = (b: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(b)));
    const genuine = sign({ nodeId, ck: ck(7), kxPk: 'ab'.repeat(32), issuedAt: 1_000 });
    expect(verifyContactCard(genuine)).toBe(true);
    // A peer's forgery an older node forwarded: it names our node, is dated at
    // the end of time, and is signed by nobody.
    const forged = { ...genuine, issuedAt: Number.MAX_SAFE_INTEGER, sig: 'ff'.repeat(64) };
    expect(verifyContactCard(forged)).toBe(false);
    expect(verifyContactCard({ ...genuine, issuedAt: 1_001 })).toBe(false); // a field changed under the signature
    expect(verifyContactCard({ ...genuine, nodeId: 'ab'.repeat(32) })).toBe(false); // another node's id
    expect(verifyContactCard({ ...genuine, sig: 'zz' })).toBe(false);
    // The handler's rule: the forwarded forgery first, the genuine card after it.
    expect(acceptNodeCard(null, forged, nodeId)).toBeNull();
    expect(acceptNodeCard(null, genuine, nodeId)).toEqual(genuine);
    expect(acceptNodeCard(genuine, forged, nodeId)).toEqual(genuine);
    const rotated = sign({ nodeId, ck: ck(8), kxPk: 'ab'.repeat(32), issuedAt: 2_000 });
    expect(acceptNodeCard(genuine, rotated, nodeId)).toEqual(rotated);
    expect(acceptNodeCard(rotated, genuine, nodeId)).toEqual(rotated); // an older genuine card never comes back
    expect(acceptNodeCard(genuine, rotated, 'ab'.repeat(32))).toEqual(genuine); // not the node we are connected to
    expect(acceptNodeCard(genuine, rotated, undefined)).toEqual(genuine);
    expect(acceptNodeCard(genuine, 'not a card', nodeId)).toEqual(genuine);
    // Round 16: the slot still holds the PREVIOUS node's card after a switch of
    // nodes — a genuine card of the node now connected replaces it whatever
    // the dates, equal or older included; dates compare within one node only.
    const previous = signed('previous', 2_000);
    expect(acceptNodeCard(previous, genuine, nodeId)).toEqual(genuine);
    expect(acceptNodeCard(signed('previous', 1_000), genuine, nodeId)).toEqual(genuine);
    expect(acceptNodeCard(previous, { ...genuine, issuedAt: 1 }, nodeId)).toEqual(previous); // ...only a VERIFIED card of ours replaces it
    expect(acceptNodeCard(previous, forged, nodeId)).toEqual(previous);
    // A forgery an older build persisted is dropped on read; a genuine card is read back.
    const store = new Map<string, string>([[NODE_CARD_KEY, JSON.stringify(forged)]]);
    const stub = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as unknown as Storage;
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
    try {
      expect(readNodeCard()).toBeNull();
      store.set(NODE_CARD_KEY, JSON.stringify(genuine));
      expect(readNodeCard()).toEqual(genuine);
    } finally {
      if (had) Object.defineProperty(globalThis, 'localStorage', had);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it('sequences caps by the clock but never at or below the last one', () => {
    expect(nextCapSeq(0, 1_000)).toBe(1_000);
    // Same millisecond still orders.
    expect(nextCapSeq(1_000, 1_000)).toBe(1_001);
    // A clock that went backwards cannot reorder caps.
    expect(nextCapSeq(5_000, 1_000)).toBe(5_001);
  });

  it('calls a room public space when bundled, when its passage is public, and when passage is unknown', () => {
    expect(roomIsPublicSpace(true, false)).toBe(true);
    expect(roomIsPublicSpace(false, true)).toBe(true);
    expect(roomIsPublicSpace(false, undefined)).toBe(true);
    expect(roomIsPublicSpace(false, false)).toBe(false);
  });
});
