/**
 * 🔒 roomOwner — the central owner gate (#141)
 *
 * The wildcard cases are the point: `owner === 'Local-Clone'` used to return
 * true for EVERY caller, and every owner-gated surface funnels through this
 * predicate. Each of those cases fails if the clause comes back.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDeedHolder, isRoomOwner, legacyOwnerMarker, ownerGateRefusal } from './roomOwner';

const ME = 'player-me';
const THEM = 'player-them';

/** The ordinary case: a real player, holding no shares anywhere. */
const plain = { playerId: ME, isVentureShareholder: false };
/** Same player, holding shares in the venture registered in THIS room. */
const shareholder = { playerId: ME, isVentureShareholder: true };

describe('isRoomOwner — the retired wildcard (#141)', () => {
  it('grants when the owner is my player id', () => {
    expect(isRoomOwner(ME, plain)).toBe(true);
  });

  it('refuses another player’s room', () => {
    expect(isRoomOwner(THEM, plain)).toBe(false);
  });

  it('REFUSES the legacy Local-Clone marker', () => {
    // The whole of #141. This returned true for everyone.
    expect(isRoomOwner('Local-Clone', plain)).toBe(false);
  });

  it('refuses Local-Clone for EVERY player, not just a stranger', () => {
    // The bug was not "the wrong person passes" — it was "everyone passes".
    for (const playerId of [ME, THEM, 'player-third', '']) {
      expect(isRoomOwner('Local-Clone', { playerId, isVentureShareholder: false })).toBe(false);
    }
  });

  it('refuses an absent owner', () => {
    // An unset field must not be a grant either — several call sites used to
    // substitute the 'Local-Clone' marker for it, which made it one.
    expect(isRoomOwner('', plain)).toBe(false);
  });

  it('still grants to a venture shareholder — #68’s V1 owner rule is intact', () => {
    // Retiring the wildcard must not take joint ownership down with it.
    expect(isRoomOwner(THEM, shareholder)).toBe(true);
  });

  it('refuses a legacy owner EVEN FOR A SHAREHOLDER', () => {
    // Review caught this: the venture branch never consults `owner`, so with
    // the legacy check ordered last a legacy room merely CONTAINING a venture
    // record stayed writable and the read-only guarantee was false.
    expect(isRoomOwner('Local-Clone', shareholder)).toBe(false);
    expect(isRoomOwner('', shareholder)).toBe(false);
  });

  it('a planted venture record cannot buy authority over a legacy room', () => {
    // Why the ordering is security-relevant and not cosmetic. A venture office
    // record is an unauthenticated peer write (#142), so if the shareholder
    // branch were reachable here, planting one would hand the attacker every
    // legacy room — moving the takeover from "walk in" to "plant one record"
    // rather than removing it.
    const attacker = { playerId: 'player-attacker', isVentureShareholder: true };
    expect(isRoomOwner('Local-Clone', attacker)).toBe(false);
  });

  it('grants nothing to a shareholder of a DIFFERENT room’s venture', () => {
    // The flag means "of the venture registered HERE" — the caller resolves it
    // against the current room, so a false flag must not leak a grant.
    expect(isRoomOwner(THEM, { playerId: ME, isVentureShareholder: false })).toBe(false);
  });
});

describe('legacyOwnerMarker — explains, never grants', () => {
  it('recognises the marker and the empty value', () => {
    expect(legacyOwnerMarker('Local-Clone')).toBe(true);
    expect(legacyOwnerMarker('')).toBe(true);
  });

  it('does not claim a real player id is legacy', () => {
    expect(legacyOwnerMarker(ME)).toBe(false);
  });

  it('agrees with isRoomOwner: everything it calls legacy is refused', () => {
    // Both share contexts, so this holds for the shareholder branch too — the
    // gap review found was exactly a legacy owner refused under one context
    // and granted under the other.
    for (const owner of ['Local-Clone', '']) {
      expect(legacyOwnerMarker(owner)).toBe(true);
      for (const ctx of [plain, shareholder]) {
        expect(isRoomOwner(owner, ctx)).toBe(false);
      }
    }
  });
});

describe('ownerGateRefusal — a legacy room reads as legacy', () => {
  const label = (o: string) => `NAME(${o})`;

  it('explains the legacy case instead of naming Local-Clone as the owner', () => {
    const msg = ownerGateRefusal('Local-Clone', 'edit', label);
    // The old text read "Only the owner (Local-Clone) can edit this room."
    expect(msg).not.toContain('Local-Clone');
    expect(msg).toContain('predates room ownership');
    expect(msg).toContain('#141');
  });

  it('names the real owner when there is one', () => {
    expect(ownerGateRefusal(THEM, 'edit', label)).toBe(
      `Only the owner (NAME(${THEM})) can edit this room.`,
    );
  });

  it('carries the action verb through both branches', () => {
    expect(ownerGateRefusal('Local-Clone', 'rename', label)).toContain('rename');
    expect(ownerGateRefusal(THEM, 'rename', label)).toContain('rename');
  });

  it('does not consult the label resolver for a legacy owner', () => {
    // Resolving 'Local-Clone' through the players map yields nothing useful;
    // calling it at all is what produced the baffling old message.
    let called = false;
    ownerGateRefusal('Local-Clone', 'edit', (o) => { called = true; return o; });
    expect(called).toBe(false);
  });
});

/**
 * 🔒 #142 — the destructive room surfaces must gate on the DEED, not on the
 * shareholder-extended predicate above.
 *
 * `isVentureShareholder` reads the current room's own venture map entry, which
 * is shape-checked, peer-written, and tied to nothing about this room or its
 * owner. So a fabricated office record passes `isRoomOwner` — and while that
 * is intended for room edits, docking and door policy, it must not carry the
 * right to lock the room out or to unseat its co-hosts. The deed hand-over and
 * the croupier election already sit with the raw deed holder; #142 moved these
 * two to join them.
 *
 * ⚠️ Read what this proves, and no more. Both gates live in `main.ts`, which
 * runs the whole client on import and so cannot be loaded by vitest — this
 * SCANS THE SOURCE for the predicate each one calls. It catches the regression
 * that matters (someone widening the gate back to `isLocalPlayerRoomOwner`)
 * and nothing else: it cannot tell you the gate is reached, or that the UI
 * agrees with it.
 *
 * What it no longer has to cover is whether the predicate itself is right.
 * `currentRoomDeedIsMine` is now a thin wrapper over `isDeedHolder` above,
 * which has real cases — including the one that matters most, that a legacy
 * marker is never RESOLVED through the peer-written `players` map. The
 * remaining owner paths (`categorizeRoom` / `roomOwnerInfo`,
 * `resolveOwnerLabel`, and the two-step confirm guards) are still
 * main.ts-only, and finishing them is its own critical-path TODO item.
 */
describe('#142 — destructive surfaces gate on the deed (source scan)', () => {
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'main.ts'), 'utf8');

  /** The body of a named top-level function, up to the next one. */
  const bodyOf = (name: string): string => {
    const start = main.indexOf(`function ${name}(`);
    expect(start, `${name} not found in main.ts`).toBeGreaterThan(-1);
    const next = main.indexOf('\nfunction ', start + 1);
    return main.slice(start, next === -1 ? main.length : next);
  };

  it('setRoomAccessMode refuses anyone but the deed holder', () => {
    const body = bodyOf('setRoomAccessMode');
    expect(body).toContain('currentRoomDeedIsMine()');
    // The widening this exists to prevent.
    expect(body).not.toContain('isLocalPlayerRoomOwner');
    expect(body).not.toContain('isLocalOwnerOfCurrentRoom');
  });

  it('the access-mode UI paints from the same predicate as the setter', () => {
    // A selector enabled for someone the setter will refuse is a button that
    // silently does nothing — the failure mode this pairing exists to avoid.
    const body = bodyOf('applyAccessModeUI');
    expect(body).toContain('currentRoomDeedIsMine()');
    // Absence matters as much as presence: `currentRoomDeedIsMine() ||
    // isLocalPlayerRoomOwner(...)` satisfies the line above while handing the
    // selector straight back to shareholders.
    expect(body).not.toContain('isLocalPlayerRoomOwner');
    expect(body).not.toContain('isLocalOwnerOfCurrentRoom');
  });

  it('the documented authority split still covers every shareholder surface', () => {
    // WHY a bare count: main.ts's isLocalPlayerRoomOwner docblock lists the
    // five surfaces shareholders reach, and that list is hand-maintained.
    // Twice in review it was wrong — first claiming co-hosts after they left,
    // then calling itself exhaustive while omitting the room-name editor. A
    // count cannot check the prose, but it does catch the thing that makes the
    // prose go stale: a SIXTH caller appearing with nobody revisiting it.
    //
    // If this fails you have added or removed a caller. Update the split in
    // that docblock — it is the single source of truth, roomOwner.ts and
    // ventures.ts both point at it — then change this number.
    const calls = (main.match(/isLocalPlayerRoomOwner\(/g) ?? []).length;
    const declarations = (main.match(/function isLocalPlayerRoomOwner\(/g) ?? []).length;
    expect(declarations).toBe(1);
    expect(calls - declarations).toBe(5);
  });

  it('the co-host section repaints when either map behind the deed check moves', () => {
    // The gate change widened this section's live dependencies: the old
    // shareholder predicate compared against our player id, while
    // currentRoomDeedIsMine() reads roomInfo.owner AND players[owner].keyB64.
    // updateRoomUI is what both map observers call, so the repaint has to
    // happen there — otherwise a deed hand-over, or the owner's players entry
    // landing late (the ordinary join order), leaves the new holder with no
    // controls and the old holder with buttons the handler refuses.
    const start = main.indexOf('const updateRoomUI = () => {');
    const end = main.indexOf('roomMap.observe(', start);
    expect(start, 'updateRoomUI not found in main.ts').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const updateRoomUI = main.slice(start, end);
    expect(updateRoomUI).toContain('renderCoHostsSection()');
    // The access-mode selector's enabled state is the same check, repainted
    // through refreshAccessRoomRow -> applyAccessModeUI.
    expect(updateRoomUI).toContain('refreshAccessRoomRow()');
  });

  it('co-host accept/deny/revoke gate on the deed, in handler and render alike', () => {
    // BOTH sites, pinned by count. They live inside one render function rather
    // than named functions of their own, and there are exactly two: the
    // delegated click handler and the markup that decides whether a REVOKE
    // button is drawn at all. Scanning the whole file for "at least one"
    // passed even if one of them was deleted or widened.
    const body = bodyOf('renderCoHostsSection');
    const bindings = body.match(/const amOwner = .*;/g) ?? [];
    expect(bindings).toEqual([
      'const amOwner = currentRoomDeedIsMine();',
      'const amOwner = currentRoomDeedIsMine();',
    ]);
    // And nothing else in the section reaches for a wider gate.
    expect(body).not.toContain('isLocalPlayerRoomOwner');
    expect(body).not.toContain('isLocalOwnerOfCurrentRoom');
  });
});

/**
 * 🏠 isDeedHolder (#141/#142) — the RAW deed check, extracted so it can be
 * tested.
 *
 * This is the narrower of the two authority predicates and the one that
 * governs everything irreversible: handing the module away, the sole-croupier
 * election, and — since #142 — the room's access mode and co-host management.
 * Until now it lived in main.ts and had no coverage at all, which is why #148
 * could only pin those gates with a source scan.
 */
describe('isDeedHolder — the deed, not owner-equivalence', () => {
  const ME = 'player-me';
  const MY_PUB = 'pub-me';
  /** No players entry for anyone — the common case. */
  const noEntries = { playerId: ME, identityPub: MY_PUB, ownerKeyB64: () => undefined };

  it('grants when the owner id is my player id', () => {
    expect(isDeedHolder(ME, noEntries)).toBe(true);
  });

  it('refuses another player, when no players entry ties them to me', () => {
    expect(isDeedHolder('player-them', noEntries)).toBe(false);
  });

  it('grants an owner id whose players entry carries MY identity key', () => {
    // The returning-owner case: same person, new player id. This is the only
    // reason the key lookup exists.
    expect(isDeedHolder('player-old-me', {
      playerId: ME, identityPub: MY_PUB, ownerKeyB64: () => MY_PUB,
    })).toBe(true);
  });

  it('refuses when the players entry carries someone else’s key', () => {
    expect(isDeedHolder('player-them', {
      playerId: ME, identityPub: MY_PUB, ownerKeyB64: () => 'pub-them',
    })).toBe(false);
  });

  it('REFUSES the legacy marker and an absent owner', () => {
    for (const owner of ['Local-Clone', '', undefined]) {
      expect(isDeedHolder(owner, noEntries)).toBe(false);
    }
  });

  it('never RESOLVES the legacy marker — the lookup is not called at all', () => {
    // #141's actual invariant, and the reason ownerKeyB64 is a function rather
    // than a resolved value. `players` is peer-written and the marker is a KEY
    // into it: an attacker writing players['Local-Clone'] = {keyB64: theirs}
    // takes the deed to every legacy room the moment anything looks it up.
    // Refusing by equality while still resolving would pass every test above
    // and leave the hole wide open.
    const looked: string[] = [];
    for (const owner of ['Local-Clone', '']) {
      expect(isDeedHolder(owner, {
        playerId: ME,
        identityPub: MY_PUB,
        ownerKeyB64: (o) => { looked.push(o); return MY_PUB; },
      })).toBe(false);
    }
    expect(looked).toEqual([]);
  });

  it('does not consult the lookup when the player id already matches', () => {
    // Not security, just the contract: the cheap branch short-circuits.
    let called = false;
    isDeedHolder(ME, {
      playerId: ME, identityPub: MY_PUB,
      ownerKeyB64: () => { called = true; return undefined; },
    });
    expect(called).toBe(false);
  });

  it('is NARROWER than isRoomOwner — a shareholder holds no deed', () => {
    // The #142 split, stated as a test: a venture shareholder passes the
    // owner-equivalent gate and must not pass this one. A fabricated office
    // record is an unauthenticated peer write, so if the deed followed
    // shareholding, planting one would buy the right to sell the module.
    const shareholder = { playerId: ME, isVentureShareholder: true };
    expect(isRoomOwner('player-them', shareholder)).toBe(true);
    expect(isDeedHolder('player-them', noEntries)).toBe(false);
  });
});

/**
 * Leaving a room hands this client none of it. `leaveRoom` gives up `yjsSync`
 * before it waits for the sync to flush and stop, and both main.ts gates fall
 * back to "offline: this client is alone" when there is no sync. Without the
 * leaving check first, a departing client — a visitor included — ran the old
 * room's croupiers and its owner-gated paths (the manual slot operator among
 * them) while its writes still went out (PR #137 review).
 *
 * ⚠️ Like the #142 block above, this SCANS the source: main.ts can't be loaded
 * by vitest. It pins the wiring (both gates check the flag before the offline
 * fallback, and leaveRoom holds the flag across the whole leave), not that a
 * frame lands inside the window.
 */
describe('leaving a room hands this client none of it (source scan)', () => {
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'main.ts'), 'utf8');

  /** The body of the predicate registered with `setter(() => { … });`. */
  const gate = (setter: string): string => {
    const start = main.indexOf(`${setter}(() => {`);
    expect(start, `${setter} not found in main.ts`).toBeGreaterThan(-1);
    return main.slice(start, main.indexOf('\n  });', start));
  };

  /** The body of a named top-level (async) function, up to the next one. */
  const bodyOf = (name: string): string => {
    const start = main.indexOf(`function ${name}(`);
    expect(start, `${name} not found in main.ts`).toBeGreaterThan(-1);
    const next = main.slice(start + 1).search(/\n(async )?function /);
    return main.slice(start, next === -1 ? main.length : start + 1 + next);
  };

  it('both gates refuse while a leave is under way, before their offline fallback', () => {
    for (const setter of ['setRoomEditPermission', 'setSoleCroupierPredicate']) {
      const body = gate(setter);
      const leaving = body.indexOf('if (roomLeavesUnderWay > 0)');
      expect(leaving, `${setter} must refuse while leaving`).toBeGreaterThan(-1);
      expect(leaving, `${setter} must refuse before "no sync ⇒ alone"`).toBeLessThan(body.indexOf('if (!yjsSync)'));
    }
  });

  it('leaveRoom holds the flag for the whole leave, the flush and the stop included', () => {
    expect(bodyOf('leaveRoom')).toMatch(
      /roomLeavesUnderWay\+\+;\s*try \{\s*await leaveRoomNow\(\);\s*\} finally \{\s*roomLeavesUnderWay--;\s*\}/,
    );
    const now = bodyOf('leaveRoomNow');
    expect(now).toContain('yjsSync = null');
    expect(now).toContain('sync.flush()');
    expect(now).toContain('await sync.stop()');
    // Nothing else lowers it: the leave's own finally is the only place.
    expect(main.match(/roomLeavesUnderWay--/g)).toHaveLength(1);
  });
});
