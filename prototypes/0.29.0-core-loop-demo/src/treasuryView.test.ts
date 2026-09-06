// treasuryView tests: the honesty rules the read-only treasury UI depends on —
// u64-safe amount formatting, phase claims only when a height exists,
// recompute-to-trust window derivation, "held" vote counts that never present
// themselves as a tally, and the plan's player-vocabulary ban.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChainSyncStatus } from './treasuryDoc';
import type {
  CompanyTreasuryPolicy,
  GovernanceKindRule,
  ProposalRegistration,
  ProposalWindows,
  RoomTreasuryBinding,
  SigningSession,
  TreasuryCheckpoint,
  TreasuryProposal,
  TreasuryVote,
} from './treasuryTypes';
import { deriveProposalWindows } from './treasuryTypes';
import * as Y from 'yjs';
import { bindGamesDoc, readRoomOwnerKey } from './games/gamesDoc';
import contracts from '../test-vectors/treasury/treasury-contracts.json';
import {
  advanceCursorPair,
  approvalsView,
  balanceView,
  bindingSigner,
  boardView,
  displayHeight,
  keyFingerprint,
  formatAmount,
  formatHeight,
  missingProposalNote,
  retreatCursorPair,
  formatShares,
  boardThresholdFor,
  checkpointsFor,
  companyScope,
  cursorPastEnd,
  droppedRecordsNote,
  formatXch,
  governanceRuleFor,
  pageRange,
  pagerNeeded,
  payloadView,
  phaseLabel,
  scopeCheckpoints,
  scopeSessions,
  sessionsFor,
  proposalKindLabel,
  proposalPhase,
  proposalRows,
  TREASURY_LABEL,
  TREASURY_MUTED,
  roomFundingView,
  scopeProposals,
  shareClassViews,
  shortId,
  sortByAmountDesc,
  syncView,
  trustTag,
  voteTallyView,
  windowsView,
} from './treasuryView';

const policy = contracts.policy.value as CompanyTreasuryPolicy;
const rule = contracts.governanceRule.rule as GovernanceKindRule;
const registration = contracts.windows.registration as ProposalRegistration;
const windows = contracts.windows.derived as ProposalWindows;

describe('amount formatting', () => {
  it('formats XCH without ever parsing a mojo string as a number', () => {
    expect(formatXch('1500000000000')).toBe('1.5 XCH');
    expect(formatXch('1000000000000')).toBe('1 XCH');
    expect(formatXch('1')).toBe('0.000000000001 XCH');
    expect(formatXch('0')).toBe('0 XCH');
    expect(formatXch('1234567000000000')).toBe('1,234.567 XCH');
    // u64::MAX — Number(mojos) would round this and silently lose value.
    expect(formatXch('18446744073709551615')).toBe('18,446,744.073709551615 XCH');
    expect(formatXch('9007199254740993')).toBe('9,007.199254740993 XCH');
  });

  it('formats whole shares at 1000 mojos per share', () => {
    expect(formatShares('1000')).toBe('1 share');
    expect(formatShares('2500')).toBe('2.5 shares');
    expect(formatShares('0')).toBe('0 shares');
  });

  it('never scales or labels a non-xch asset as XCH', () => {
    expect(formatAmount('xch', '2000000000000')).toBe('2 XCH');
    const cat = formatAmount('a'.repeat(64), '4200');
    expect(cat).toContain('4200');
    expect(cat).not.toContain('XCH');
  });

  it('shortens ids and shows heights as heights', () => {
    expect(shortId('a'.repeat(64))).toBe('aaaaaa…aaaa');
    expect(shortId('abc')).toBe('abc');
    expect(formatHeight(5000000)).toBe('#5,000,000');
  });
});

describe('proposal phase', () => {
  it('refuses to claim a phase without a height', () => {
    expect(proposalPhase(windows, null)).toBe('unknown-height');
    expect(phaseLabel('unknown-height')).toContain('unknown');
  });

  it('refuses to claim a phase when the height precedes acceptance', () => {
    // Both inputs are peer-written; a height before the acceptance block means
    // they disagree. Falling through to "Voting open" would invent a phase out
    // of an inconsistency.
    expect(proposalPhase(windows, windows.acceptedHeight - 1)).toBe('unknown-height');
    expect(proposalPhase(windows, 0)).toBe('unknown-height');
  });

  it('places the proposal on each clock at the boundaries', () => {
    const w = windows;
    expect(proposalPhase(w, w.acceptedHeight)).toBe('voting');
    expect(proposalPhase(w, w.votingEndsHeight - 1)).toBe('voting');
    expect(proposalPhase(w, w.votingEndsHeight)).toBe('veto');
    expect(proposalPhase(w, w.vetoEndsHeight)).toBe('timelock');
    expect(proposalPhase(w, w.executableFromHeight)).toBe('executable');
    expect(proposalPhase(w, w.expiresAfterHeight)).toBe('expired');
    expect(proposalPhase(w, w.expiresAfterHeight + 10_000)).toBe('expired');
  });
});

describe('window derivation (recompute to trust)', () => {
  // The proposal these records are filed under: same id, kind and version as
  // the golden-vector registration, so identity checks pass.
  const subject = {
    ...(contracts.proposal.unsigned as object),
    proposalId: registration.proposalId,
    policyVersion: registration.policyVersion,
    kind: registration.kind,
    proposerSig: 'sig',
  } as TreasuryProposal;

  it('recomputes rather than trusting the cached copy', () => {
    const v = windowsView(subject, registration, rule, null);
    expect(v.source).toBe('recomputed');
    expect(v.windows).toEqual(deriveProposalWindows(registration, rule));
    // Recomputation does not outrank its inputs: both the acceptance record
    // and the policy are shape-only caches, so claiming a higher trust level
    // would rank the peer-controlled path above the copy it replaced.
    expect(v.trust.level).toBe('unverified');
    expect(v.note).toMatch(/has (not )?checked against the chain|neither/i);
  });

  it('says which input is missing rather than blaming the acceptance record', () => {
    const noPolicy = windowsView(subject, registration, null, null);
    expect(noPolicy.note).toMatch(/policy/i);
    expect(noPolicy.note).not.toMatch(/not been accepted|no acceptance record/i);
    const noRegistration = windowsView(subject, null, rule, null);
    expect(noRegistration.note).toMatch(/acceptance record/i);
  });

  it('ignores a tampered cache when it can recompute', () => {
    const tampered = { ...windows, expiresAfterHeight: windows.expiresAfterHeight + 999 };
    const v = windowsView(subject, registration, rule, tampered);
    expect(v.windows?.expiresAfterHeight).toBe(windows.expiresAfterHeight);
  });

  it('falls back to the cached copy, marked unverified, when it cannot recompute', () => {
    const v = windowsView(subject, null, null, windows);
    expect(v.source).toBe('cached');
    expect(v.trust.level).toBe('unverified');
  });

  it('reports absence rather than throwing on malformed inputs', () => {
    const bad = { ...registration, acceptedHeight: -1 } as ProposalRegistration;
    const v = windowsView(subject, bad, rule, null);
    expect(v.source).toBe('none');
    expect(v.windows).toBeNull();
    expect(windowsView(subject, null, null, null).trust.level).toBe('absent');
  });
});

describe('votes and approvals', () => {
  const vote = (choice: TreasuryVote['choice'], id: string): TreasuryVote => ({
    ...(contracts.vote.unsigned as object),
    choice,
    voteId: id,
    gameSig: 'sig',
  } as TreasuryVote);

  const checkpoint = (confirmed: boolean): TreasuryCheckpoint => ({
    ...(contracts.checkpoint.body as object),
    checkpointId: contracts.checkpoint.checkpointId,
    ...(confirmed ? { confirmedHeight: 5_000_100 } : {}),
  } as TreasuryCheckpoint);

  it('will not say no round is open when it only saw part of the records', () => {
    // The warnings under this note say a round may be unread or on another
    // page. An unconditional "No approval round open in this room" beside
    // them made the panel contradict itself — and the confident half was the
    // wrong half.
    const partial = approvalsView([], null, 5_000_000, false);
    expect(partial.note).not.toMatch(/no approval round open in this room/i);
    expect(partial.note).toMatch(/not the same as there being none/i);
    // With a complete view the plain statement is fine, and is what it says.
    const whole = approvalsView([], null, 5_000_000, true);
    expect(whole.note).toMatch(/no approval round open in this room/i);
  });

  it('counts held votes by choice without presenting a tally', () => {
    const t = voteTallyView(
      [vote('yes', '1'.repeat(64)), vote('yes', '2'.repeat(64)), vote('veto', '3'.repeat(64))],
      [checkpoint(true)],
    );
    expect(t.held).toBe(3);
    expect(t.yes).toBe(2);
    expect(t.veto).toBe(1);
    expect(t.records).toBe(1);
    expect(t.trust.level).toBe('unverified');
    // Slots are keyed by signing key and one person can hold several, so
    // "one per voter" would imply a deduplication that never happens.
    expect(t.note).toMatch(/one per signing key/i);
    expect(t.note).not.toMatch(/one per voter/i);
  });

  it('never lets a peer-written confirmation flag soften the caveat', () => {
    // confirmedHeight sits OUTSIDE a vote record's fingerprint and the record
    // carries no signature, so any peer can mint "confirmed". The caveat must
    // therefore be unconditional — identical whatever the records claim.
    const withClaim = voteTallyView([vote('yes', '1'.repeat(64))], [checkpoint(true)]);
    const without = voteTallyView([vote('yes', '1'.repeat(64))], [checkpoint(false)]);
    const none = voteTallyView([], []);
    expect(withClaim.caveat).toBe(without.caveat);
    expect(none.caveat).toBe(withClaim.caveat);
    expect(withClaim.caveat).toMatch(/only counts once/i);
    // And no field reports a "confirmed" count that a peer could fabricate.
    expect(Object.keys(withClaim)).not.toContain('confirmedRecords');
    expect(JSON.stringify(withClaim)).not.toMatch(/confirmedHeight/);
  });

  const session = (collected: number, threshold: number): SigningSession => ({
    v: 1,
    sessionId: 'a'.repeat(64),
    networkGenesisChallenge: 'a'.repeat(64),
    companyId: 'b'.repeat(64),
    policyVersion: 1,
    proposalId: 'c'.repeat(64),
    bundleHash: 'd'.repeat(64),
    requiredThreshold: threshold,
    collectedSigs: Array.from({ length: collected }, (_, i) => ({
      signerPuzzleHash: `${i}`.repeat(64),
      sig: 's',
    })),
    expiresAfterHeight: 100,
  });

  it('reports one round, never a figure spliced from two', () => {
    // Round A has more signatures; round B claims a bigger threshold. The old
    // per-field maxima would report "2 of 9" — a state no round is in.
    const a = approvalsView([session(2, 3), session(0, 9)], null);
    expect(a.collected).toBe(2);
    expect(a.required).toBe(3);
    expect(a.trust.level).toBe('unverified');
  });

  it("prefers the policy threshold over the round's peer-authored copy", () => {
    const withPolicy = approvalsView([session(1, 99)], 2);
    expect(withPolicy.required).toBe(2);
    expect(withPolicy.requiredFromPolicy).toBe(true);
    const withoutPolicy = approvalsView([session(1, 99)], null);
    expect(withoutPolicy.required).toBe(99);
    expect(withoutPolicy.requiredFromPolicy).toBe(false);
    expect(approvalsView([], null).note).toMatch(/No approval round/i);
  });
});

describe('matching records to the proposal they claim', () => {
  const proposal = contracts.proposal.unsigned as TreasuryProposal;
  const matching = {
    ...policy,
    companyId: proposal.companyId,
    policyVersion: proposal.policyVersion,
  };

  it('only uses a policy for the same company and version', () => {
    expect(governanceRuleFor(proposal, matching)).toEqual(matching.governanceRules[proposal.kind]);
    expect(governanceRuleFor(proposal, { ...matching, companyId: '9'.repeat(64) })).toBeNull();
    expect(governanceRuleFor(proposal, { ...matching, policyVersion: proposal.policyVersion + 1 })).toBeNull();
    expect(governanceRuleFor(proposal, null)).toBeNull();
  });

  it('takes the board threshold only from a matching policy revision', () => {
    expect(boardThresholdFor(proposal, matching)).toBe(matching.board.threshold);
    // Another revision of the same company describes a different board.
    expect(boardThresholdFor(proposal, { ...matching, policyVersion: 99 })).toBeNull();
    expect(boardThresholdFor(proposal, { ...matching, companyId: '9'.repeat(64) })).toBeNull();
    expect(boardThresholdFor(proposal, null)).toBeNull();
  });

  it('drops vote records filed under another company', () => {
    // Records are keyed by proposal id alone, so a self-consistent one from
    // another company would otherwise be counted among this proposal's.
    const cp = (companyId: string): TreasuryCheckpoint => ({
      ...(contracts.checkpoint.body as object),
      checkpointId: contracts.checkpoint.checkpointId,
      companyId,
      proposalId: proposal.proposalId,
    } as TreasuryCheckpoint);
    const mine = cp(proposal.companyId);
    expect(checkpointsFor([mine, cp('9'.repeat(64))], proposal)).toEqual([mine]);
    // And says how many it dropped: a silent filter turned a foreign record
    // held under this proposal's keys into "Vote records held: 0" as fact.
    const scoped = scopeCheckpoints([mine, cp('9'.repeat(64)), cp('8'.repeat(64))], proposal);
    expect(scoped.kept).toEqual([mine]);
    expect(scoped.dropped).toBe(2);
    expect(scopeCheckpoints([mine], proposal).dropped).toBe(0);
  });

  it('words what was dropped as held-but-not-counted, and says nothing when nothing was', () => {
    expect(droppedRecordsNote(0, 'approval round')).toBeNull();
    const one = droppedRecordsNote(1, 'approval round');
    expect(one).toMatch(/^1 approval round held under this proposal/);
    expect(one).toMatch(/different company or policy revision/);
    expect(one).toMatch(/not counted above/);
    const many = droppedRecordsNote(3, 'vote record');
    expect(many).toMatch(/^3 vote records held under this proposal/);
    expect(many).toMatch(/are not counted above/);
  });

  it('drops approval rounds belonging to another company or revision', () => {
    const round = (over: Partial<SigningSession>): SigningSession => ({
      v: 1,
      sessionId: 'a'.repeat(64),
      networkGenesisChallenge: 'a'.repeat(64),
      companyId: proposal.companyId,
      policyVersion: proposal.policyVersion,
      proposalId: proposal.proposalId,
      bundleHash: 'd'.repeat(64),
      requiredThreshold: 2,
      collectedSigs: [],
      expiresAfterHeight: 100,
      ...over,
    });
    const mine = round({});
    const all = [
      mine,
      round({ companyId: '9'.repeat(64) }),
      round({ policyVersion: proposal.policyVersion + 1 }),
      round({ proposalId: '9'.repeat(64) }),
    ];
    expect(sessionsFor(all, proposal)).toEqual([mine]);
    // The dropped count is what stops the approvals panel from asserting "No
    // approval round open in this room" over a round it just set aside: the
    // scan-level counts see a clean page, so only the filter can say.
    const scoped = scopeSessions(all, proposal);
    expect(scoped.kept).toEqual([mine]);
    expect(scoped.dropped).toBe(3);
    // A foreign round alone, with nothing else wrong on the page: the panel
    // must be told the view is incomplete, and then must not claim absence.
    const foreignOnly = scopeSessions([round({ companyId: '9'.repeat(64) })], proposal);
    expect(foreignOnly.kept).toEqual([]);
    expect(foreignOnly.dropped).toBe(1);
    const note = approvalsView(foreignOnly.kept, null, 5_000_000, foreignOnly.dropped === 0).note;
    expect(note).not.toMatch(/no approval round open in this room/i);
    expect(note).toMatch(/not the same as there being none/i);
  });
});

describe('records must claim the proposal they are filed under', () => {
  const proposal = {
    ...(contracts.proposal.unsigned as object),
    proposalId: contracts.windows.registration.proposalId,
    proposerSig: 'sig',
  } as TreasuryProposal;

  it('ignores a registration whose kind or version disagrees', () => {
    // The cache keys registrations by proposal id alone, so a peer can file
    // one describing a different rulebook. Splicing it with this proposal's
    // rule would produce clocks it never answered to.
    const wrongKind = { ...registration, kind: 'dissolve' } as ProposalRegistration;
    expect(windowsView(proposal, wrongKind, rule, null).source).toBe('none');
    const wrongVersion = { ...registration, policyVersion: 99 } as ProposalRegistration;
    expect(windowsView(proposal, wrongVersion, rule, null).source).toBe('none');
    // The matching one still works.
    expect(windowsView(proposal, registration, rule, null).source).toBe('recomputed');
  });

  it('says a conflicting record is conflicting, not missing', () => {
    // Rejecting a mismatched record must not be reported as "none is held":
    // that would turn a hostile peer write into a reassuring absence, and
    // NO DATA in the badge would say the same thing again.
    const wrongKind = { ...registration, kind: 'dissolve' } as ProposalRegistration;
    const v = windowsView(proposal, wrongKind, null, null);
    expect(v.note).toMatch(/different proposal/i);
    expect(v.note).not.toMatch(/no acceptance record/i);
    expect(v.trust.level).toBe('unverified');
    // A genuinely empty slot still reads as absent.
    const empty = windowsView(proposal, null, null, null);
    expect(empty.note).toMatch(/no acceptance record/i);
    expect(empty.trust.level).toBe('absent');
  });

  it('names a rejected CACHED clock record too, not just a rejected acceptance', () => {
    // A mismatched cached record is what lifts the badge off NO DATA, so
    // leaving it out of the note had the badge and the sentence beside it
    // disagree — and the "nothing is held" wording denied a record sitting in
    // the room. Every branch that can carry one has to mention it.
    const wrongCache = {
      ...windows,
      proposalId: 'f'.repeat(64),
    } as ProposalWindows;
    const alone = windowsView(proposal, null, null, wrongCache);
    expect(alone.trust.level).toBe('unverified');
    expect(alone.note).toMatch(/different proposal or policy version/i);
    // Still true when a usable acceptance record is held but no policy is.
    const withRegistration = windowsView(proposal, registration, null, wrongCache);
    expect(withRegistration.note).toMatch(/company policy is missing/i);
    expect(withRegistration.note).toMatch(/different proposal or policy version/i);
    // And nothing is invented when no cached record was rejected.
    expect(windowsView(proposal, registration, null, null).note)
      .not.toMatch(/different proposal or policy version/i);
  });

  it('marks unusable-but-present inputs unverified rather than absent', () => {
    const bad = { ...registration, acceptedHeight: Number.MAX_SAFE_INTEGER } as ProposalRegistration;
    const v = windowsView(proposal, bad, rule, null);
    expect(v.windows).toBeNull();
    // Both inputs were held; NO DATA would contradict the note.
    expect(v.trust.level).toBe('unverified');
    expect(v.note).toMatch(/do not produce sensible clocks/i);
  });

  it('ignores cached windows filed under the wrong proposal or version', () => {
    const foreign = { ...windows, proposalId: '9'.repeat(64) } as ProposalWindows;
    expect(windowsView(proposal, null, null, foreign).source).toBe('none');
    const wrongVersion = { ...windows, policyVersion: 99 } as ProposalWindows;
    expect(windowsView(proposal, null, null, wrongVersion).source).toBe('none');
    expect(windowsView(proposal, null, null, windows).source).toBe('cached');
  });
});

describe('company scope', () => {
  const binding = (companyId: string): RoomTreasuryBinding => ({
    v: 1,
    networkGenesisChallenge: 'a'.repeat(64),
    roomId: 'room-1',
    companyId,
    treasuryLauncherId: 'c'.repeat(64),
    policyVersion: 1,
    profileId: 'p1',
    boundByPub: 'pub',
    boundAtHeight: 1,
    policyReceiptId: 'd'.repeat(64),
    sig: 'sig',
  });

  it('withholds the cached company when it disagrees with the signed binding', () => {
    // The binding is signed; the policy cache is replaceable. A peer writing
    // a policy for another company must not get its board rendered beside
    // this room's real funding line.
    const s = companyScope(binding('a'.repeat(64)), { ...policy, companyId: 'b'.repeat(64) }, 'owner');
    expect(s.mismatch).toBe(true);
    expect(s.companyId).toBeNull();
    expect(s.warning).toMatch(/do not match/i);
    // The signed funding record stays on screen, so the warning must say what
    // is actually withheld rather than claiming nothing is shown.
    expect(s.warning).toMatch(/proposal list/i);
    expect(s.warning).not.toMatch(/neither is shown/i);
  });

  it('treats a different treasury as a mismatch even when the company agrees', () => {
    // Both records name a treasury; a policy for the right company but the
    // wrong treasury would otherwise have its board and fee ceiling rendered
    // as if the signed funding record agreed.
    const s = companyScope(binding(policy.companyId), {
      ...policy,
      treasuryLauncherId: '9'.repeat(64),
    }, 'owner');
    expect(s.mismatch).toBe(true);
    expect(s.companyId).toBeNull();
  });

  it('uses the agreed company, or whichever one is known', () => {
    const agreed = companyScope(binding(policy.companyId), policy, 'owner');
    expect(agreed.mismatch).toBe(false);
    expect(agreed.companyId).toBe(policy.companyId);
    expect(companyScope(null, policy).companyId).toBe(policy.companyId);
    expect(companyScope(binding('e'.repeat(64)), null, 'owner').companyId).toBe('e'.repeat(64));
    expect(companyScope(null, null).companyId).toBeNull();
  });
});

describe('scoping and staleness', () => {
  const mk = (companyId: string, id: string): TreasuryProposal => ({
    ...(contracts.proposal.unsigned as object),
    companyId,
    proposalId: id,
    proposerSig: 'sig',
  } as TreasuryProposal);

  it("lists only the shown company's proposals and counts the rest", () => {
    const mine = mk('a'.repeat(64), '1'.repeat(64));
    const scoped = scopeProposals(
      [mine, mk('b'.repeat(64), '2'.repeat(64)), mk('b'.repeat(64), '3'.repeat(64))],
      'a'.repeat(64),
    );
    expect(scoped.shown).toEqual([mine]);
    expect(scoped.otherCompanies).toBe(2);
    expect(scoped.scopeUnknown).toBe(false);
  });

  it('withholds the list entirely when no company can be identified', () => {
    // Rows carry no company, so an unscoped list would present several
    // companies' proposals as one board's business. Report the count instead.
    const unscoped = scopeProposals(
      [mk('a'.repeat(64), '1'.repeat(64)), mk('b'.repeat(64), '2'.repeat(64))],
      null,
    );
    expect(unscoped.shown).toEqual([]);
    expect(unscoped.scopeUnknown).toBe(true);
    expect(unscoped.otherCompanies).toBe(2);
  });

  it('leaves an ended approval round out instead of showing it as progress', () => {
    const round = (collected: number, expires: number): SigningSession => ({
      v: 1,
      sessionId: 'a'.repeat(64),
      networkGenesisChallenge: 'a'.repeat(64),
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      proposalId: 'c'.repeat(64),
      bundleHash: 'd'.repeat(64),
      requiredThreshold: 3,
      collectedSigs: Array.from({ length: collected }, (_, i) => ({
        signerPuzzleHash: `${i}`.repeat(64),
        sig: 's',
      })),
      expiresAfterHeight: expires,
    });
    // A dead round with MORE signatures must not hide the live one.
    const dead = round(5, 100);
    const live = round(1, 900);
    const at500 = approvalsView([dead, live], 3, 500);
    expect(at500.collected).toBe(1);
    expect(at500.sessions).toBe(1);
    expect(at500.note).toMatch(/past its end height/i);
    // The height doing that filtering is itself a peer's claim — one could
    // hide live rounds or revive ended ones, so the basis must be named.
    expect(at500.note).toMatch(/another player reported/i);
    expect(approvalsView([live], 3, 500).note).toMatch(/another player reported/i);
    // With no height, nothing can be judged stale — say so rather than guess.
    const noHeight = approvalsView([dead, live], 3, null);
    expect(noHeight.collected).toBe(5);
    expect(noHeight.note).toMatch(/cannot be judged/i);
  });
});

describe('payload view', () => {
  it('describes whether the details are held, without dumping raw data', () => {
    const held = payloadView('ok');
    expect(held.present).toBe(true);
    expect(held.headline).toMatch(/held in this room/i);
    // The cache only returns payload bytes whose hash it recomputed, so this
    // is the one genuinely self-checked panel — and it must say so.
    expect(held.trust.level).toBe('self-checked');
    const missing = payloadView('absent');
    expect(missing.present).toBe(false);
    expect(missing.trust.level).toBe('absent');
    expect(missing.detail).toMatch(/cannot be shown/i);
    for (const s of [held.headline, held.detail, missing.headline, missing.detail]) {
      expect(s).not.toMatch(/[0-9a-f]{16,}/); // never raw hex at the player
    }
  });

  it('does not report details the room HOLDS as details it lacks', () => {
    // A payload over the local size cap, or one that fails its fingerprint,
    // is still something the room is holding. Both used to arrive as the same
    // null as an empty slot and render "Details not held here" with NO DATA.
    for (const status of ['too-large', 'unreadable'] as const) {
      const v = payloadView(status);
      expect(v.present).toBe(false);
      expect(v.headline).not.toMatch(/not held here/i);
      expect(v.detail).toMatch(/holding/i);
      // Held means the badge cannot say "nothing cached for this yet".
      expect(v.trust.level).not.toBe('absent');
      expect(v.trust.detail).not.toMatch(/nothing cached/i);
      expect(v.headline).not.toMatch(/[0-9a-f]{16,}/);
    }
    // And the size refusal names itself as this device's limit.
    expect(payloadView('too-large').detail).toMatch(/this device’s limit/i);
  });
});

describe('balances, sync, and the local verdict', () => {
  it('reports the absence of a balance source instead of showing a number', () => {
    const b = balanceView();
    expect(b.available).toBe(false);
    expect(b.headline).toMatch(/no verified balance/i);
    expect(JSON.stringify(b)).not.toMatch(/\b0\.0+\b/);
  });

  it('keeps the local verdict unavailable even when a peer claims verified', () => {
    const peer: ChainSyncStatus = {
      v: 1,
      networkGenesisChallenge: 'a'.repeat(64),
      state: 'verified',
      verifiedHeight: 5_000_000,
    };
    const s = syncView(peer);
    expect(s.localState).toBe('unavailable');
    expect(s.peerClaim).toBe('verified');
    expect(s.peerHeight).toBe(5_000_000);
    // The peer claim is a shape-only cache like every other panel's data, so
    // it carries the same explicit badge rather than prose alone.
    expect(s.trust.level).toBe('unverified');
    expect(syncView(null).peerClaim).toBeNull();
    expect(syncView(null).trust.level).toBe('absent');
  });

  it('labels where a display height came from', () => {
    expect(displayHeight(null)).toEqual({ height: null, source: 'none' });
    expect(displayHeight({
      v: 1,
      networkGenesisChallenge: 'a'.repeat(64),
      state: 'degraded',
      verifiedHeight: 42,
    })).toEqual({
      height: 42,
      source: 'peer-reported',
    });
    // A status with no height cannot supply one.
    expect(displayHeight({
      v: 1,
      networkGenesisChallenge: 'a'.repeat(64),
      state: 'unavailable',
    }).height).toBeNull();
  });
});

describe('policy, shares, and room funding', () => {
  it('renders the board as an unverified cache', () => {
    const b = boardView(policy);
    expect(b.threshold).toBe(2);
    expect(b.signers).toBe(3);
    expect(b.trust.level).toBe('unverified');
    expect(b.maxFee).toContain('XCH');
  });

  it('reads share classes without offering creation', () => {
    const classes = shareClassViews(policy);
    expect(classes.items).toHaveLength(1);
    expect(classes.truncated).toBe(false);
    expect(classes.hidden).toBe(0);
    expect(classes.items[0].id).toBe('common');
    expect(Object.keys(classes.items[0])).toEqual([
      'id', 'votesPerWholeShare', 'grantsRoomAccess', 'transferable',
    ]);
  });

  it('caps how many share classes it will hand over, and says how many it dropped', () => {
    // The policy key is peer-writable and shape-only, and nothing in the
    // record schema limits how many classes it declares — so an unbounded
    // list here became an unbounded row count in the phone's COMPANY panel,
    // rebuilt on every repaint a peer chose to trigger. The proposal list
    // beside it has capped and disclosed its page all along; same contract.
    const many = {
      ...policy,
      shareClasses: Array.from({ length: 40 }, (_unused, i) => ({
        ...policy.shareClasses[0],
        id: `class-${i}`,
        assetId: `${i}`.padStart(64, '0'),
      })),
    } as CompanyTreasuryPolicy;
    const capped = shareClassViews(many, 5);
    expect(capped.items).toHaveLength(5);
    expect(capped.truncated).toBe(true);
    // The count is what the on-screen line reports, so it has to be right.
    expect(capped.hidden).toBe(35);
    // A cap at or above the real length drops nothing and claims nothing.
    const whole = shareClassViews(many, 40);
    expect(whole.items).toHaveLength(40);
    expect(whole.truncated).toBe(false);
    expect(whole.hidden).toBe(0);
    // Degenerate budgets stay honest rather than throwing or over-reporting.
    const zero = shareClassViews(many, 0);
    expect(zero.items).toHaveLength(0);
    expect(zero.truncated).toBe(true);
    expect(zero.hidden).toBe(40);
  });

  it('distinguishes "cannot read" from "no record exists"', () => {
    // A read that cannot run is not evidence of absence — the terminal used
    // to report an unconfigured build as "no company funding record".
    for (const access of ['no-network', 'no-room'] as const) {
      const disabled = roomFundingView(null, null, access);
      expect(disabled.headline).toMatch(/unavailable/i);
      expect(disabled.headline).not.toMatch(/no company funding record/i);
    }
    const readableButEmpty = roomFundingView(null, null, 'readable');
    expect(readableButEmpty.headline).toMatch(/no company funding record/i);
  });

  it('names WHICH obstacle stopped the read, since they are different facts', () => {
    // Rolled into one boolean, an unconfigured build got blamed on a failing
    // room connection — wrong, and unactionable: nothing about the room is
    // broken. That was every build today, since no genesis is configured.
    const noNetwork = roomFundingView(null, null, 'no-network');
    expect(noNetwork.detail).toMatch(/no company network is set up/i);
    // Must not pin it on the room, which is working fine.
    expect(noNetwork.detail).not.toMatch(/not attached to a room/i);
    const noRoom = roomFundingView(null, null, 'no-room');
    expect(noRoom.detail).toMatch(/not attached to a room/i);
    expect(noRoom.detail).not.toMatch(/network/i);
  });

  it('reports a missing binding as missing, not as personal funding', () => {
    const unbound = roomFundingView(null);
    expect(unbound.bound).toBe(false);
    // Knowing nothing is not the same as knowing the room is self-funded.
    expect(unbound.headline).toMatch(/no company funding record/i);
    expect(unbound.trust.level).toBe('absent');
    expect(unbound.readOnlyNote).toMatch(/does not check the chain/i);
    expect(unbound.unavailable.length).toBeGreaterThan(0);
  });

  const expiring = (expiresAfterHeight: number | undefined): RoomTreasuryBinding => ({
    v: 1,
    networkGenesisChallenge: 'a'.repeat(64),
    roomId: 'room-1',
    companyId: 'b'.repeat(64),
    treasuryLauncherId: 'c'.repeat(64),
    policyVersion: 2,
    profileId: 'casino-floor',
    boundByPub: 'pub',
    boundAtHeight: 100,
    ...(expiresAfterHeight === undefined ? {} : { expiresAfterHeight }),
    policyReceiptId: 'd'.repeat(64),
    sig: 'sig',
  });

  it('keeps "no height to judge by" distinct from "has not ended"', () => {
    // The regression this guards: a boolean `lapsed` made both of these
    // false, so a record that had ended rendered as current funding.
    const base = expiring(200);
    expect(roomFundingView(base, 250).expiryStatus).toBe('passed');
    expect(roomFundingView(base, 150).expiryStatus).toBe('not-passed');
    expect(roomFundingView(base, null).expiryStatus).toBe('unknown');
    // A record naming no end height is a fourth case again, and the only one
    // where the signature alone settles the question.
    expect(roomFundingView(expiring(undefined), 150).expiryStatus).toBe('none');
    // Boundary: the end height itself counts as reached.
    expect(roomFundingView(base, 200).expiryStatus).toBe('passed');
  });

  it('treats a height that contradicts the record as no answer at all', () => {
    // A peer-reported height BELOW the binding's own boundAtHeight says the
    // chain has not reached the block the record claims to have started at.
    // Two peer-written numbers disagreeing is not evidence the funding is
    // current, so it is 'unknown' — the same treatment proposalPhase gives a
    // height that precedes acceptance.
    const base = expiring(200); // boundAtHeight is 100
    expect(roomFundingView(base, 50).expiryStatus).toBe('unknown');
    expect(roomFundingView(base, 99).expiryStatus).toBe('unknown');
    // At the bound height and above, the two agree and the question is
    // answerable again.
    expect(roomFundingView(base, 100).expiryStatus).toBe('not-passed');
    expect(roomFundingView(base, 250).expiryStatus).toBe('passed');
    // The note says it cannot tell, rather than asserting either way.
    expect(roomFundingView(base, 50).expiryNote).toMatch(/cannot say whether/i);
  });

  it('labels every expiry verdict apart from the record’s own signature', () => {
    const base = expiring(200);
    // The signature covers the record and the end height it names — never the
    // claim about where the chain has got to, so BOTH readings are qualified.
    expect(roomFundingView(base, 250).expiryNote).toMatch(/not covered by the signature/i);
    expect(roomFundingView(base, 150).expiryNote).toMatch(/not covered by the signature/i);
    expect(roomFundingView(base, null).expiryNote).toMatch(/cannot say whether it has passed/i);
    // Nothing to qualify when no end height is named, or no record is held.
    expect(roomFundingView(expiring(undefined), 150).expiryNote).toBeNull();
    expect(roomFundingView(null).expiryNote).toBeNull();
  });

  it('never claims live funding — every held record is headlined as a record', () => {
    // Not even a record naming NO end height earns "Company funding" on its
    // own. Its signature shows who wrote the statement, not that they were
    // entitled to, that the chain confirmed it, or that it has not since been
    // unbound — so open-ended is no more evidence of live funding than
    // expiring, and only the passed case adds anything to the headline.
    for (const [expires, height] of [
      [undefined, 150],
      [undefined, null],
      [200, 150],
      [200, null],
    ] as const) {
      const headline = roomFundingView(expiring(expires), height).headline;
      expect(headline).toBe('Company funding record');
      expect(headline).not.toMatch(/may have ended/i);
    }
    expect(roomFundingView(expiring(200), 250).headline).toMatch(/may have ended/i);
  });

  it('withholds company details when the signed binding is held but unusable', () => {
    // The binding is the SIGNED anchor; the policy is freely writable by any
    // peer. Treating an unusable binding as no binding let the policy name
    // the company on its own — so writing junk over the binding slot and then
    // a policy of your choosing put YOUR company's board, fingerprint and
    // proposals on someone else's room screen.
    const otherPolicy = { ...policy, companyId: 'd'.repeat(64) } as CompanyTreasuryPolicy;
    for (const standing of ['unreadable', 'too-large'] as const) {
      const held = companyScope(null, otherPolicy, standing);
      expect(held.companyId).toBeNull();
      expect(held.mismatch).toBe(true);
      expect(held.warning).toMatch(/cannot be read/i);
    }
    // With no binding held at all, the policy may still stand alone — that is
    // an ordinary room that has not been bound yet, not a neutralised anchor.
    const unbound = companyScope(null, otherPolicy, 'absent');
    expect(unbound.companyId).toBe('d'.repeat(64));
    expect(unbound.mismatch).toBe(false);
  });

  it('separates company funding from edit rights, and exposes the profile', () => {
    const binding: RoomTreasuryBinding = {
      v: 1,
      networkGenesisChallenge: 'a'.repeat(64),
      roomId: 'room-1',
      companyId: 'b'.repeat(64),
      treasuryLauncherId: 'c'.repeat(64),
      policyVersion: 2,
      profileId: 'p1',
      boundByPub: 'pub',
      boundAtHeight: 100,
      policyReceiptId: 'd'.repeat(64),
      sig: 'sig',
    };
    const bound = roomFundingView(binding, null, 'readable', { status: 'known', pub: 'pub', source: 'room-doc' });
    expect(bound.bound).toBe(true);
    expect(bound.policyVersion).toBe(2);
    expect(bound.trust.level).toBe('signed');
    expect(bound.detail).toMatch(/edit rights/i);
    expect(bound.profileId).toBe('p1');
    expect(bound.treasuryId).toBe('c'.repeat(64));
    // The owner's signature says the owner bound the room — never that the
    // company agreed to fund it, which is the chain's to say.
    expect(bound.trust.detail).toMatch(/not that the company agreed/i);
  });
});

describe('proposal rows', () => {
  const proposal = (id: string, kind: TreasuryProposal['kind']): TreasuryProposal => ({
    ...(contracts.proposal.unsigned as object),
    kind,
    proposalId: id,
    proposerSig: 'sig',
  } as TreasuryProposal);

  it('sorts newest-accepted first and stays stable for unaccepted ones', () => {
    const view = (w: ProposalWindows | null): ReturnType<typeof windowsView> =>
      w
        ? { windows: w, source: 'cached', trust: trustTag('unverified'), note: '' }
        : { windows: null, source: 'none', trust: trustTag('absent'), note: '' };
    const rows = proposalRows(
      [proposal('c'.repeat(64), 'pay'), proposal('a'.repeat(64), 'dissolve'), proposal('b'.repeat(64), 'budget')],
      (p) => view(p.proposalId.startsWith('c') ? { ...windows, acceptedHeight: 10 } : p.proposalId.startsWith('b') ? { ...windows, acceptedHeight: 20 } : null),
      null,
      'none',
    );
    // Each row keeps the trust of the clocks its phase came from, so the list
    // can badge a peer-copied cache differently from a matched record.
    expect(rows[0].clockTrust.level).toBe('unverified');
    expect(rows[2].clockTrust.level).toBe('absent');
    expect(rows.map((r) => r.proposalId[0])).toEqual(['b', 'c', 'a']);
    expect(rows[0].kindLabel).toBe('Budget');
    // With clocks but no height: position unknown. Without clocks at all:
    // a different state entirely, not the same label.
    expect(rows[0].phase).toBe('unknown-height');
    expect(rows[2].phase).toBe('no-clocks');
    expect(phaseLabel('no-clocks')).not.toBe(phaseLabel('unknown-height'));
    // Every row carries where its height came from, so the list can say so.
    expect(rows.every((r) => r.heightSource === 'none')).toBe(true);
  });

  it('carries where each row’s clocks came from, not just how trusted they are', () => {
    // Both paths badge UNVERIFIED — correctly, since both rest on
    // peer-written inputs — so the trust tag alone cannot tell a window
    // copied wholesale from another player from one worked out here. Without
    // the source the list rendered them identically.
    const subject = {
      ...(contracts.proposal.unsigned as object),
      proposalId: registration.proposalId,
      policyVersion: registration.policyVersion,
      kind: registration.kind,
      proposerSig: 'sig',
    } as TreasuryProposal;
    const rowFor = (view: (p: TreasuryProposal) => ReturnType<typeof windowsView>) =>
      proposalRows([subject], view, 5_000_000, 'peer-reported')[0];

    const recomputed = rowFor((p) => windowsView(p, registration, rule, null));
    expect(recomputed.clockSource).toBe('recomputed');
    expect(recomputed.clockSourceLabel).toMatch(/worked out here/i);

    const copied = rowFor((p) => windowsView(p, null, null, windows));
    expect(copied.clockSource).toBe('cached');
    expect(copied.clockSourceLabel).toMatch(/copied/i);

    // Same badge, different provenance — which is exactly the case that was
    // indistinguishable before, so assert both halves together.
    expect(copied.clockTrust.level).toBe(recomputed.clockTrust.level);
    expect(copied.clockSourceLabel).not.toBe(recomputed.clockSourceLabel);

    // No clocks at all names no source rather than inventing one.
    const none = rowFor((p) => windowsView(p, null, null, null));
    expect(none.clockSource).toBe('none');
    expect(none.clockSourceLabel).toBeNull();
  });

  it('never labels a proposal executable — the chain decides that', () => {
    expect(phaseLabel('executable')).not.toMatch(/executable|ready for the board/i);
  });

  it('labels every proposal kind in player language', () => {
    expect(proposalKindLabel('bind-room')).toBe('Fund a room');
    expect(proposalKindLabel('rotate-board')).toBe('Rotate board');
    expect(proposalKindLabel('appoint-manager')).toBe('Appoint manager');
  });

  it('sorts amounts with the no-parse comparator', () => {
    const items = [{ m: '999' }, { m: '18446744073709551615' }, { m: '1000' }];
    expect(sortByAmountDesc(items, (i) => i.m).map((i) => i.m)).toEqual([
      '18446744073709551615', '1000', '999',
    ]);
  });
});

describe('player vocabulary rule', () => {
  it('never emits banned chain jargon in any display string', () => {
    // The plans' language rule: players see venture/company/shares/Registry;
    // singleton, CAT, vault and checkpoint coin must never reach game UI.
    // "trustless" too: the amendment (§15.5) reserves it for claims a node
    // verified locally, and nothing on this screen is one.
    const banned = /\b(singleton|vault|checkpoint coin|mojo|trustless)\b|\bCAT\b/i;
    const subject = {
      ...(contracts.proposal.unsigned as object),
      proposalId: registration.proposalId,
      policyVersion: registration.policyVersion,
      kind: registration.kind,
      proposerSig: 'sig',
    } as TreasuryProposal;
    const strings: string[] = [
      ...Object.values(trustTag('signed')),
      ...Object.values(trustTag('unverified')),
      ...Object.values(trustTag('self-checked')),
      ...Object.values(trustTag('absent')),
      balanceView().headline,
      balanceView().detail,
      syncView(null).localNote,
      boardView(policy).note,
      roomFundingView(null).headline,
      roomFundingView(null).detail,
      // Every signer state's strings, and every scope warning.
      ...[
        { status: 'known', pub: 'k'.repeat(43), source: 'room-doc' } as const,
        { status: 'known', pub: 'k'.repeat(43), source: 'head-verified' } as const,
        { status: 'known', pub: 'k'.repeat(43), source: 'head-unverified' } as const,
        { status: 'known', pub: 'z'.repeat(43), source: 'room-doc' } as const,
        { status: 'unknown' } as const,
        { status: 'legacy' } as const,
      ].flatMap((owner) => {
        const v = roomFundingView(VOCAB_BINDING, null, 'readable', owner);
        return [v.headline, v.detail, v.trust.label, v.trust.detail, v.signerLabel ?? '', v.companyApproval ?? ''];
      }),
      ...(['absent', 'unreadable', 'too-large', 'owner', 'owner-unknown', 'no-owner-key', 'not-owner'] as const)
        .flatMap((s) => [companyScope(null, policy, s).warning ?? '', companyScope(null, policy, s).note ?? '']),
      voteTallyView([], []).note,
      voteTallyView([], []).caveat,
      approvalsView([], null).note,
      ...(['ok', 'absent', 'unreadable', 'too-large'] as const).flatMap((s) => [
        payloadView(s).headline,
        payloadView(s).detail,
        payloadView(s).trust.detail,
      ]),
      windowsView(subject, registration, rule, null).note,
      windowsView(subject, null, null, null).note,
      windowsView(subject, null, null, windows).note,
      windowsView(subject, null, null, null, true).note,
      ...Object.values(PHASE_STRINGS),
      ...['pay', 'budget', 'appoint-manager', 'revoke-manager', 'bind-room',
        'change-policy', 'rotate-board', 'add-share-class', 'dissolve',
      ].map((k) => proposalKindLabel(k as TreasuryProposal['kind'])),
    ];
    for (const s of strings) {
      expect(typeof s).toBe('string');
      expect(s, `banned vocabulary in: ${s}`).not.toMatch(banned);
    }
  });

  it('keeps every caveat colour above the contrast a player can actually read', () => {
    // These started as alpha gold over a dark surface, which composites to
    // about 2.6:1 — dimmest on exactly the states most worth reading. Worse,
    // the value was duplicated, so fixing the badge left the phone's `dim()`
    // and the terminal's notes behind. Measured here rather than asserted in
    // a comment, so the palette cannot drift back.
    const srgb = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string): number => {
      const n = parseInt(hex.replace('#', ''), 16);
      return 0.2126 * srgb((n >> 16) & 255)
        + 0.7152 * srgb((n >> 8) & 255)
        + 0.0722 * (srgb(n & 255));
    };
    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    // Both dark surfaces the treasury draws on.
    const PHONE_SCREEN = '#04060f';
    const TERMINAL_PANEL = '#040816';
    for (const surface of [PHONE_SCREEN, TERMINAL_PANEL]) {
      // 4.5:1 is the WCAG AA floor for normal text, and none of this text is
      // large enough to qualify for the relaxed threshold.
      expect(contrast(TREASURY_MUTED, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(TREASURY_LABEL, surface)).toBeGreaterThanOrEqual(4.5);
    }
    // Labels stay brighter than caveats, so the hierarchy the dimming was
    // for survives — it just no longer costs legibility.
    expect(luminance(TREASURY_LABEL)).toBeGreaterThan(luminance(TREASURY_MUTED));
    // Sanity-check the measure itself against a known pair.
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1);
  });

  it('keeps the detail screen’s verification budget an AGGREGATE, not per scan', () => {
    // The detail screen runs three scans on every repaint — votes, vote
    // records and approval rounds — and handing each the full budget made one
    // repaint do three times the documented work while the comment above the
    // constant claimed otherwise. A peer replacing records under all three
    // prefixes defeats the memo in each at once, so the aggregate is the only
    // figure that means anything.
    //
    // Read from source because these live in a 7k-line entry point that has no
    // export seam; the arithmetic is the invariant worth pinning, not the
    // numbers themselves.
    const root = dirname(fileURLToPath(import.meta.url));
    const main = readFileSync(join(root, 'main.ts'), 'utf8');
    const num = (name: string): number => {
      const hit = main.match(new RegExp(`^const ${name} = (\\d+);`, 'm'));
      expect(hit, `${name} not found — did the constant move or get renamed?`)
        .not.toBeNull();
      return Number(hit![1]);
    };
    const checks = num('DETAIL_CHECKS');
    const scans = num('DETAIL_SCANS');
    expect(checks).toBeGreaterThan(0);
    // DETAIL_PAGE is derived, so assert the derivation rather than a literal.
    expect(main).toMatch(/^const DETAIL_PAGE = DETAIL_CHECKS \/ DETAIL_SCANS;$/m);
    expect(checks / scans).toBeGreaterThanOrEqual(1);
    // The three scans really do take the per-scan share, not the whole budget.
    // Checked against EACH CALL'S OWN arguments: a fixed-width window after the
    // call name ran into the next call, so a neighbour's DETAIL_PAGE satisfied
    // the assertion and the check passed with the defect reintroduced.
    const detail = main.slice(main.indexOf('const DETAIL_SCAN ='));
    for (const scan of ['scanVotes(', 'scanCheckpoints(', 'scanSigningSessions(']) {
      let from = 0;
      let calls = 0;
      for (;;) {
        const at = detail.indexOf(scan, from);
        if (at < 0) break;
        // These calls contain no nested parentheses, so the first one closes.
        const args = detail.slice(at, detail.indexOf(')', at));
        expect(args, `${scan} should take the per-scan share`).toContain('DETAIL_PAGE');
        expect(args, `${scan} must not take the whole repaint budget`)
          .not.toContain('DETAIL_CHECKS');
        calls += 1;
        from = at + scan.length;
      }
      expect(calls, `${scan} not found on the detail screen`).toBeGreaterThan(0);
    }
    // And the number of scans the constant divides by is the number there are.
    expect(scans).toBe(3);
  });

  it('keeps banned jargon out of the treasury UI source itself', () => {
    // The view module is only half the surface: the strings a player actually
    // reads are literals in the render function, the terminal panel and the
    // markup. Scan those directly, scoped to the treasury code.
    const banned = /\b(singleton|vault|checkpoint coin|trustless)\b|\bCAT\b/i;
    const root = dirname(fileURLToPath(import.meta.url));
    const treasuryBlocks: { where: string; text: string }[] = [];
    const push = (where: string, text: string) => treasuryBlocks.push({ where, text });
    push('treasuryView.ts', readFileSync(join(root, 'treasuryView.ts'), 'utf8'));
    push('treasuryNetwork.ts', readFileSync(join(root, 'treasuryNetwork.ts'), 'utf8'));
    // Two treasury strings a player reads BEFORE the treasury opens, and both
    // sat outside every slice below: the VENTURES row that opens it, and the
    // phone-app registry entry that titles it. A rename to "board · vault ›"
    // would have shipped with this guard green.
    const mainSrc = readFileSync(join(root, 'main.ts'), 'utf8');
    const venturesRow = mainSrc.indexOf('data-phone-app="treasury"');
    expect(venturesRow, 'VENTURES row that opens the treasury not found').toBeGreaterThan(-1);
    const venturesSlice = mainSrc.slice(venturesRow - 300, venturesRow + 600);
    expect(venturesSlice).toContain('🏦 TREASURY');
    push('main.ts VENTURES row', venturesSlice);
    const registry = mainSrc.indexOf('elId: "phone-app-treasury"');
    expect(registry, 'phone-app registry entry for the treasury not found').toBeGreaterThan(-1);
    const registrySlice = mainSrc.slice(registry - 100, registry + 300);
    expect(registrySlice).toContain('🏦 TREASURY');
    push('main.ts phone-app registry', registrySlice);
    // main.ts: just the function that builds the markup. Not
    // renderTreasuryApp (the focus-preserving wrapper) and not
    // paintTreasuryApp (now the guard plus two calls) — either would scan
    // none of the player-visible strings this guard exists to cover. The
    // assertions below are what make that mistake loud instead of silent.
    const main = readFileSync(join(root, 'main.ts'), 'utf8');
    const start = main.indexOf('function paintTreasuryBody');
    const end = main.indexOf('\nfunction ', start + 1);
    expect(start, 'paintTreasuryBody not found — did the render split change?')
      .toBeGreaterThan(-1);
    const slice = main.slice(start, end > 0 ? end : undefined);
    // Prove the slice really holds rendered strings, so a future rename
    // cannot quietly reduce this to scanning nothing.
    expect(slice).toContain('BALANCES');
    expect(slice).toContain('PROPOSALS');
    push('main.ts paintTreasuryApp', slice);
    // devices.ts: the FUNDING panel markup and its refresh block.
    // devices.ts holds the FUNDING code in TWO separate places — the refresh
    // block that fills the panel, and the markup that declares it (including
    // the disabled command labels). Both must be scanned, and the ids appear
    // in both, so take the FIRST and LAST occurrence rather than one marker
    // that resolves twice into the same region.
    const devices = readFileSync(join(root, 'devices.ts'), 'utf8');
    const marker = 'device-terminal-funding-source';
    const first = devices.indexOf(marker);
    const last = devices.lastIndexOf(marker);
    expect(first).toBeGreaterThan(-1);
    expect(last, 'FUNDING markup and refresh block should be distinct regions')
      .toBeGreaterThan(first);
    // The refresh block runs to where its assembled lines are written out.
    // A fixed character window stopped short of that and silently missed
    // every literal in the `lines` array — all of it player-visible
    // textContent. Slice to the write itself, and self-check it, so the same
    // shortfall cannot happen quietly again.
    const refreshEnd = devices.indexOf('fundDetailEl.textContent', first);
    expect(refreshEnd, 'refresh block end marker not found').toBeGreaterThan(first);
    const refresh = devices.slice(first - 600, refreshEnd + 200);
    for (const literal of ['NOT SHOWN YET', 'BOUND AT', 'PROFILE ']) {
      expect(refresh, `refresh slice missing ${literal}`).toContain(literal);
    }
    push('devices.ts refresh block', refresh);
    push('devices.ts FUNDING markup', devices.slice(last - 600, last + 2500));
    // The markup slice must actually contain the player-visible command
    // labels, or this test is guarding nothing.
    const markup = treasuryBlocks[treasuryBlocks.length - 1].text;
    for (const label of ['REQUEST COMPANY FUNDING', 'SELECT PROFILE', 'UNBIND', 'REFRESH PROOF']) {
      expect(markup, `markup slice missing ${label}`).toContain(label);
    }
    const html = readFileSync(join(root, '..', 'index.html'), 'utf8');
    const t = html.indexOf('phone-app-treasury');
    push('index.html treasury view', html.slice(Math.max(0, t - 600), t + 200));

    for (const block of treasuryBlocks) {
      // Only player-visible text matters, so ignore lines that are pure code
      // comments (which legitimately cite the plans' internal vocabulary).
      const visible = block.text
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      const hit = visible.match(banned);
      expect(hit, `banned vocabulary in ${block.where}: ${hit?.[0]}`).toBeNull();
    }
  });
});

describe('paired cursor history', () => {
  // Walk the pair the way the buttons do, so a test failure names the page the
  // player would be looking at rather than an array.
  const walk = (
    steps: ReadonlyArray<'next' | 'prev'>,
    aPages: number,
    bPages: number,
  ): { a: string | null; b: string | null } => {
    let pair = { a: [null as string | null], b: [null as string | null] };
    // A scan reports a next cursor only while pages remain. Cursor VALUES are
    // keys, so name them after the page they open: 'a2' opens vote page 2.
    const nextOf = (side: 'a' | 'b', pages: number) => {
      const depth = pair[side].length; // 1 => showing page 1
      return depth < pages ? `${side}${depth + 1}` : null;
    };
    for (const step of steps) {
      pair =
        step === 'next'
          ? (advanceCursorPair(pair, nextOf('a', aPages), nextOf('b', bPages)) as typeof pair)
          : (retreatCursorPair(pair) as typeof pair);
    }
    return { a: pair.a[pair.a.length - 1], b: pair.b[pair.b.length - 1] };
  };

  it('rewinds both key spaces by one step when one has run out', () => {
    // The reported case: 2 vote pages, 4 checkpoint pages. The third NEXT can
    // only advance checkpoints, and the PREVIOUS after it must restore the
    // view the second NEXT produced — vote page 2 with checkpoint page 3.
    expect(walk(['next', 'next', 'next'], 2, 4)).toEqual({ a: 'a2', b: 'b4' });
    expect(walk(['next', 'next', 'next', 'prev'], 2, 4)).toEqual({ a: 'a2', b: 'b3' });
    // Not page 1: the old code popped a stack that never grew on that step.
    expect(walk(['next', 'next', 'next', 'prev'], 2, 4).a).not.toBeNull();
  });

  it('returns to the first page after undoing every step', () => {
    const steps = ['next', 'next', 'next', 'next', 'prev', 'prev', 'prev', 'prev'] as const;
    expect(walk(steps, 2, 4)).toEqual({ a: null, b: null });
  });

  it('keeps the two histories the same height', () => {
    let pair = { a: [null as string | null], b: [null as string | null] };
    for (const [aNext, bNext] of [['a2', 'b2'], [null, 'b3'], ['a3', null], [null, null]] as const) {
      pair = advanceCursorPair(pair, aNext, bNext) as typeof pair;
      expect(pair.a.length).toBe(pair.b.length);
    }
  });

  it('records nothing when neither side has a further page', () => {
    const pair = { a: ['a2'], b: ['b2'] };
    // A step that changes nothing must not be undoable, or PREVIOUS would
    // spend a press going back to the page already shown.
    expect(advanceCursorPair(pair, null, null)).toBe(pair);
  });

  it('holds at the first page rather than underflowing', () => {
    const first = { a: [null], b: [null] };
    expect(retreatCursorPair(first)).toBe(first);
  });
});

describe('pager visibility', () => {
  // Read from source: the predicate lives in the 7k-line entry point with no
  // export seam, and what matters is that it is no longer "more than one page
  // of records exist", which is a fact about the MAP and not about where the
  // reader is standing in it.
  const root = dirname(fileURLToPath(import.meta.url));
  const main = readFileSync(join(root, 'main.ts'), 'utf8');

  it('asks where the reader is, not how many records remain', () => {
    // A cursor with history, a page starting partway in, or a page with more
    // after it: any of those and the controls stay, whatever `matched` says.
    const whole = { matched: 5, startIndex: 0, nextCursor: null };
    expect(pagerNeeded(whole, 8, [null])).toBe(false);
    expect(pagerNeeded({ ...whole, matched: 9 }, 8, [null])).toBe(true);
    expect(pagerNeeded({ ...whole, startIndex: 3 }, 8, [null])).toBe(true);
    expect(pagerNeeded({ ...whole, nextCursor: 'k' }, 8, [null])).toBe(true);
    // The deletion attack: a peer drops `matched` to one page's worth while
    // the reader is past that page. Only the history says so, and it must be
    // enough on its own — or PREVIOUS vanishes with the block.
    expect(pagerNeeded({ matched: 4, startIndex: 4, nextCursor: null }, 8, [null, 'k'])).toBe(true);
  });

  it('rewinds on a cursor past the end, never on an empty page', () => {
    // `items` holds only ACCEPTED records: a page of rejects is empty with its
    // keys still there, and rewinding on that let a peer plant one invalid
    // page ahead of an honest record and bounce NEXT straight back off it.
    expect(cursorPastEnd({ matched: 9, startIndex: 4 })).toBe(false); // all-rejected page
    expect(cursorPastEnd({ matched: 9, startIndex: 9 })).toBe(true); // past every key
    expect(cursorPastEnd({ matched: 9, startIndex: 12 })).toBe(true);
    expect(cursorPastEnd({ matched: 0, startIndex: 0 })).toBe(false); // empty map
  });

  it('never prints an inverted page range', () => {
    // The state a rewind repairs, worded honestly in case a caller does not:
    // 8 records, cursor past all of them, page of 8 used to read "9–8 of 8".
    expect(pageRange({ matched: 8, startIndex: 8 }, 8)).toBe('past the end of 8');
    expect(pageRange({ matched: 8, startIndex: 0 }, 8)).toBe('1–8 of 8');
    expect(pageRange({ matched: 20, startIndex: 8 }, 8)).toBe('9–16 of 20');
    expect(pageRange({ matched: 10, startIndex: 8 }, 8)).toBe('9–10 of 10');
    expect(pageRange({ matched: 0, startIndex: 0 }, 8)).toBe('none held');
  });

  it('rewinds every paged scan on the phone, the detail screen included', () => {
    // The list rewound on the right condition and the three detail scans did
    // not rewind at all, so records leaving behind their cursor left the
    // VOTES panel reading "Held here: 0" for a room still holding a page of
    // verified votes. The predicate is unit-tested above; this pins that
    // every scan goes through it, since the loops themselves live in main.ts.
    const from = main.indexOf('function paintTreasuryBody(');
    const body = main.slice(from, main.indexOf('\nfunction ', from + 1));
    for (const scan of ['page', 'voteScan', 'cpScan', 'sessionScan']) {
      expect(body, `${scan} is not rewound when its cursor is past the end`)
        .toContain(`cursorPastEnd(${scan})`);
    }
    // And no hand-rolled copy of the condition survives beside the shared one.
    expect(body).not.toMatch(/startIndex >= \w+\.matched/);
    // The vote and checkpoint histories rewind as a PAIR — the equal-height
    // invariant advanceCursorPair relies on — never by popping one side.
    expect(body).toContain('retreatCursorPair({ a: treasuryVoteCursors, b: treasuryCheckpointCursors })');
    expect(body).not.toMatch(/treasury(Vote|Checkpoint)Cursors\.pop\(\)/);
  });

  it('discloses a cut-short search on all three panels, apart from ordinary paging', () => {
    // "There is another page" and "the walk that builds the pages stopped
    // early" are different claims, and only the second means NEXT may never
    // arrive. This is the author's stated mitigation on the one open review
    // thread, and the rounds block has been rewritten several times — any of
    // the three notes could have been dropped with nothing failing.
    const from = main.indexOf('function paintTreasuryBody(');
    const body = main.slice(from, main.indexOf('\nfunction ', from + 1));
    for (const flag of [
      'voteScan.discoveryCutShort || cpScan.discoveryCutShort',
      'sessionScan.discoveryCutShort',
      'page.discoveryCutShort',
    ]) {
      const at = body.indexOf(flag);
      expect(at, `${flag} is not rendered`).toBeGreaterThan(-1);
      expect(body.slice(at, at + 400), `${flag} is rendered without saying paging cannot reach`)
        .toContain('paging cannot reach');
    }
  });

  it('says on screen what the per-proposal filters left out', () => {
    // The filters return the dropped count; the screen has to print it, and
    // fold it into the approvals panel's `complete` argument, or the flat
    // "No approval round open in this room" comes back for a round the room
    // holds under this proposal's own keys.
    expect(main).toContain('droppedRecordsNote(scopedCheckpoints.dropped, "vote record")');
    expect(main).toContain('droppedRecordsNote(scopedSessions.dropped, "approval round")');
    // Computed AND rendered — a note nobody paints is not a disclosure.
    expect(main).toContain('${droppedVoteRecords ? dim(esc(droppedVoteRecords)) : ""}');
    expect(main).toContain('${droppedRounds ? dim(esc(droppedRounds)) : ""}');
    expect(main).toContain('scopedSessions.dropped === 0');
  });

  it('gates the phone and the terminal on the same three obstacles', () => {
    // leaveRoom() destroys the treasury document and KEEPS activeBootstrap as
    // last-room memory, so a roomId outlives the document it named. A gate
    // reading roomId alone calls that readable. The terminal has always
    // included the document in its own check; the phone did not, and two
    // surfaces disagreeing about what "readable" means is how this screen
    // contradicted itself once before.
    const devices = readFileSync(join(root, 'devices.ts'), 'utf8');
    for (const [where, src] of [['main.ts', main], ['devices.ts', devices]] as const) {
      const at = src.indexOf('const access: FundingReadAccess');
      expect(at, `${where} has no FundingReadAccess gate to check`).toBeGreaterThan(-1);
      // The whole conditional: from the declaration to the semicolon that
      // ends it. A fixed-width window is what let an earlier test in this
      // file pass by reading a neighbour's code instead of its own.
      const gate = src.slice(at, src.indexOf(';', at));
      // Either spelling: the phone holds the answer in `bound`, the terminal
      // calls treasuryDocBound() inline.
      expect(gate, `${where} decides readability without the room document`)
        .toMatch(/bound/i);
      // And all three obstacles stay distinct — collapsing them is what made
      // the terminal blame the room connection for an unconfigured build.
      expect(gate, `${where} lost the no-network branch`).toContain('no-network');
      expect(gate, `${where} lost the no-room branch`).toContain('no-room');
    }
  });

  it('leaves no treasury screen without a way out by keyboard', () => {
    // The phone header's Back button is OUTSIDE this view, the global Tab
    // handler stops browser traversal, the arrow handler only searches
    // inside the view, and Escape goes to Home rather than to the parent
    // app. So a branch that paints the whole screen without a focusable
    // return traps a keyboard-only player. The "not connected" branch did:
    // it is the one screen with nothing else on it, so it offered no stop at
    // all and the arrow handler found zero elements to move between.
    //
    // Checked at every assignment rather than at the one that was wrong,
    // because the control existed and was reasoned about — it was simply
    // absent from one branch, and nothing said the branches had to agree.
    // Bounded to THIS function. An unbounded slice ran on into the Ventures
    // app's own painters and failed on their markup — the same mistake as
    // reading a fixed-width window, which this file has now made twice.
    const from = main.indexOf('function paintTreasuryBody(');
    expect(from, 'paintTreasuryBody not found — did it move or get renamed?')
      .toBeGreaterThan(-1);
    const end = main.indexOf('\nfunction ', from + 1);
    expect(end, 'no function follows paintTreasuryBody — bound check is unsound')
      .toBeGreaterThan(from);
    const body = main.slice(from, end);
    const assignments = [...body.matchAll(/view\.innerHTML = `/g)];
    expect(assignments.length).toBeGreaterThan(4);
    for (const at of assignments) {
      const head = body.slice(at.index!, at.index! + 120);
      // Either the in-view Ventures return, or ALL PROPOSALS, which reaches
      // the list screen that carries one. Both must come FIRST, so the first
      // arrow press lands on a way out.
      expect(head, `a treasury screen paints with no keyboard route out: ${head.slice(0, 80)}`)
        .toMatch(/\$\{verdictBanner\}\$\{back/);
    }
  });

  it('shows which network the records are pinned to', () => {
    // `label` was documented as player-facing and settable through
    // VITE_SSF_TREASURY_NETWORK, and nothing read it: the option changed
    // nothing on screen, so a build pinned to a test network looked exactly
    // like one pinned to the real one. On a screen about money that is the
    // distinction most worth showing, and a configuration contract with no
    // reader is a promise the build does not keep.
    expect(main).toMatch(/net\.configured \? row\("Records pinned to", esc\(net\.label\)\)/);
    // On the panel about chain trust, not somewhere incidental.
    const chain = main.indexOf('CHAIN VIEW');
    expect(chain).toBeGreaterThan(-1);
    expect(main.indexOf('net.label')).toBeGreaterThan(chain);
  });

  it('gates the open proposal read like every other read on the screen', () => {
    // This was the one ungated call, and the one whose result becomes a
    // positive claim about the room.
    expect(main).toContain('cacheReadable ? readProposalResult(treasuryDetailId) : null');
    expect(main).not.toMatch(/^\s*const proposalResult = readProposalResult\(/m);
  });

  it('gates every treasury pager on it, so none can shrink out of reach', () => {
    // The defect: `matched > PAGE` alone. A peer deleting earlier keys drops
    // `matched` to one page's worth while the reader sits past that page, and
    // the whole block — PREVIOUS included — disappears, stranding everything
    // behind the cursor. Three panels had it; all three must be converted, or
    // the one left behind is still strandable.
    for (const scan of ['voteScan', 'cpScan', 'sessionScan', 'page']) {
      const bad = new RegExp(`${scan}\\.matched > (DETAIL_PAGE|LIST_CHECKS)\\s*(\\?|\\|\\||$)`, 'm');
      expect(main, `${scan} still gates its pager on record count alone`)
        .not.toMatch(bad);
    }
    expect(main).toContain('pagerNeeded(voteScan, DETAIL_PAGE, treasuryVoteCursors)');
    expect(main).toContain('pagerNeeded(cpScan, DETAIL_PAGE, treasuryCheckpointCursors)');
    expect(main).toContain('pagerNeeded(sessionScan, DETAIL_PAGE, treasuryApprovalCursors)');
    expect(main).toContain('pagerNeeded(page, LIST_CHECKS, treasuryListCursors)');
  });
});

describe('the open proposal that is not there', () => {
  it('never reports a removal it did not observe', () => {
    // The cache reader answers a lookup it COULD NOT PERFORM with the same
    // `absent` it uses for an empty slot — both are "no map". So the screen
    // needs a state the reader cannot supply, or a disabled read renders as
    // "your proposal was removed": a claim about the room, from a question
    // this device never asked.
    const unavailable = missingProposalNote('unavailable');
    expect(unavailable).not.toMatch(/no longer|removed|deleted/i);
    expect(unavailable).toMatch(/not known|cannot read/i);
    // And it must not go the other way either — silence about the obstacle
    // would leave the player reading an empty screen with no account of why.
    expect(unavailable.length).toBeGreaterThan(0);
  });

  it('keeps held-but-unreadable distinct from gone', () => {
    // A peer can drop something malformed or oversized into the open slot.
    // The record is still in the room; only this device's reading failed.
    for (const held of ['too-large', 'unreadable'] as const) {
      expect(missingProposalNote(held)).toMatch(/still held in this room/);
      expect(missingProposalNote(held)).not.toMatch(/no longer/);
    }
    // Genuine absence is the ONLY state allowed to say the record is gone.
    expect(missingProposalNote('absent')).toMatch(/no longer/);
  });

  it('gives each state its own wording', () => {
    const notes = (['absent', 'unreadable', 'too-large', 'unavailable'] as const)
      .map(missingProposalNote);
    expect(new Set(notes).size).toBe(4);
  });
});

describe('share class paging', () => {
  const many = (n: number) =>
    ({
      ...policy,
      shareClasses: Array.from({ length: n }, (_unused, i) => ({
        ...policy.shareClasses[0],
        id: `class-${i}`,
        assetId: `${i}`.padStart(64, '0'),
      })),
    }) as CompanyTreasuryPolicy;

  it('reaches the classes past the first page', () => {
    // Truncating with only a "35 more" note left those 35 unreachable for
    // good, and the policy key is peer-writable — so filler classes declared
    // ahead of the real ones hid them the way planted proposals once did.
    const all = many(40);
    const first = shareClassViews(all, 24, 0);
    expect(first.items).toHaveLength(24);
    expect(first.startIndex).toBe(0);
    expect(first.hasMore).toBe(true);
    expect(first.total).toBe(40);

    const second = shareClassViews(all, 24, 24);
    expect(second.items.map((c) => c.id)).toEqual(
      Array.from({ length: 16 }, (_u, i) => `class-${24 + i}`),
    );
    expect(second.hasMore).toBe(false);
    expect(second.startIndex).toBe(24);
  });

  it('walks every class in the policy across pages', () => {
    const all = many(97);
    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 20; guard++) {
      const page = shareClassViews(all, 24, offset);
      seen.push(...page.items.map((c) => c.id));
      if (!page.hasMore) break;
      offset = page.startIndex + page.items.length;
    }
    expect(seen).toHaveLength(97);
    expect(new Set(seen).size).toBe(97);
  });

  it('clamps an offset the policy has shrunk beneath', () => {
    // The offset outlives the repaint, so a policy that loses classes under
    // it must not leave the reader on a page that does not exist — with a
    // total insisting there is plenty to see and no control that moves.
    const page = shareClassViews(many(5), 24, 400);
    expect(page.startIndex).toBe(4);
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(5);
  });

  it('says nothing is held rather than dividing an empty policy into pages', () => {
    const none = { ...policy, shareClasses: [] } as CompanyTreasuryPolicy;
    const page = shareClassViews(none, 24, 0);
    expect(page.items).toHaveLength(0);
    expect(page.startIndex).toBe(0);
    expect(page.hasMore).toBe(false);
    expect(page.truncated).toBe(false);
  });
});

/** A held binding under a realistic-length key, for the signer tests. */
const VOCAB_BINDING: RoomTreasuryBinding = {
  v: 1,
  networkGenesisChallenge: 'a'.repeat(64),
  roomId: 'room-1',
  companyId: 'b'.repeat(64),
  treasuryLauncherId: 'c'.repeat(64),
  policyVersion: 1,
  profileId: 'p1',
  boundByPub: 'k'.repeat(43),
  boundAtHeight: 100,
  policyReceiptId: 'd'.repeat(64),
  sig: 'sig',
};

describe('who signed the funding record (plan §10.1, room side)', () => {
  // The cache layer verifies a binding's signature against the key the record
  // ITSELF carries, which proves authorship and nothing more: any peer can
  // mint a key, sign a binding naming any company, and overwrite this room's
  // slot. The screen used to badge that SIGNED and let it decide which
  // company's board and proposals were "this room's". Only the room owner's
  // signature makes it the room's binding.
  const owner = { status: 'known', pub: 'k'.repeat(43), source: 'room-doc' } as const;
  const stranger = { status: 'known', pub: 'z'.repeat(43), source: 'room-doc' } as const;
  const unknown = { status: 'unknown' } as const;
  const legacy = { status: 'legacy' } as const;

  it('classifies the signer against the owner key, owner only', () => {
    expect(bindingSigner(VOCAB_BINDING, owner)).toBe('owner');
    expect(bindingSigner(VOCAB_BINDING, stranger)).toBe('not-owner');
    expect(bindingSigner(VOCAB_BINDING, unknown)).toBe('owner-unknown');
    expect(bindingSigner(VOCAB_BINDING, legacy)).toBe('no-owner-key');
  });

  it('badges only the owner’s signature as signed, and says what the signature shows', () => {
    const v = roomFundingView(VOCAB_BINDING, null, 'readable', owner);
    expect(v.bound).toBe(true);
    expect(v.signer).toBe('owner');
    expect(v.trust.level).toBe('signed');
    expect(v.trust.label).toBe('OWNER-SIGNED');
    expect(v.trust.detail).toMatch(/not that the company agreed/i);
    // Provenance: a room-doc owner is "as its records name them", never
    // "confirmed against the deed" — that clause is reserved for a key an
    // issue-#138 head supplied AND this device's node verified.
    expect(v.trust.detail).toMatch(/as its records currently name them/i);
    expect(v.trust.detail).not.toMatch(/confirmed against/i);
    const headVerified = roomFundingView(VOCAB_BINDING, null, 'readable', { ...owner, source: 'head-verified' });
    expect(headVerified.trust.detail).toMatch(/confirmed against the room’s deed/i);
    const headUnverified = roomFundingView(VOCAB_BINDING, null, 'readable', { ...owner, source: 'head-unverified' });
    expect(headUnverified.trust.detail).not.toMatch(/confirmed against/i);
    expect(v.signerLabel).toMatch(/room owner/i);
    expect(v.companyId).toBe('b'.repeat(64));
    // The company-side predicate is stated as unchecked, with the receipt it
    // would rest on, so an owner signature is never read as company consent.
    expect(v.companyApproval).toMatch(/not checked here/i);
    expect(v.companyApproval).toContain(shortId('d'.repeat(64)));
  });

  it('refuses a stranger’s signature as this room’s funding, without denying the record', () => {
    const v = roomFundingView(VOCAB_BINDING, null, 'readable', stranger);
    expect(v.bound).toBe(false);
    expect(v.signer).toBe('not-owner');
    expect(v.trust.level).toBe('unverified');
    expect(v.trust.label).toBe('NOT OWNER-SIGNED');
    expect(v.headline).toMatch(/not signed by the room owner/i);
    // Held, so the headline is about a record — never "no company funding".
    expect(v.headline).not.toMatch(/no company funding record/i);
    // But no company billboard: the ids a planted record names are the
    // attacker's choice.
    expect(v.companyId).toBeNull();
    expect(v.treasuryId).toBeNull();
    expect(v.profileId).toBeNull();
    // The signer is still named, so the refusal is a fact on screen.
    expect(v.signerLabel).toMatch(/not the room owner/i);
    expect(v.signerLabel).toContain(keyFingerprint('k'.repeat(43)));
    expect(v.companyApproval).toBeNull();
  });

  it('never fails open when the owner is unknown or the room has no keyed owner', () => {
    // Once synced, the only peer action that produces "owner unknown" is
    // deleting or overwriting the owner's players entry — so a rule that
    // trusted any signer then would turn censorship into forgery.
    const u = roomFundingView(VOCAB_BINDING, null, 'readable', unknown);
    expect(u.signer).toBe('owner-unknown');
    expect(u.trust.level).toBe('unverified');
    expect(u.trust.label).toBe('OWNER UNKNOWN');
    expect(u.trust.detail).toMatch(/not learned this room’s owner key yet/i);
    expect(u.bound).toBe(true); // shown as the claim it is
    expect(u.signerLabel).toMatch(/owner not yet known/i);
    const l = roomFundingView(VOCAB_BINDING, null, 'readable', legacy);
    expect(l.signer).toBe('no-owner-key');
    expect(l.trust.level).toBe('unverified');
    expect(l.trust.label).toBe('NO OWNER KEY');
    expect(l.signerLabel).toMatch(/no keyed owner/i);
    // And a caller that forgets the owner key gets the honest default, never
    // a SIGNED badge.
    expect(roomFundingView(VOCAB_BINDING).trust.level).toBe('unverified');
    expect(roomFundingView(VOCAB_BINDING).signer).toBe('owner-unknown');
  });

  it('never prints a raw signing key — fingerprints only', () => {
    const raw = 'k'.repeat(43);
    for (const ownerKey of [owner, stranger, unknown, legacy]) {
      const v = roomFundingView(VOCAB_BINDING, null, 'readable', ownerKey);
      for (const s of [v.headline, v.detail, v.trust.detail, v.signerLabel ?? '', v.companyApproval ?? '']) {
        expect(s).not.toContain(raw);
      }
      expect(v.signerLabel).toContain(keyFingerprint(raw));
    }
    expect(keyFingerprint(raw).length).toBeLessThan(raw.length);
  });

  it('anchors the company scope on the owner’s binding alone', () => {
    // The owner's binding decides which company the screen shows.
    const anchored = companyScope(VOCAB_BINDING, null, 'owner');
    expect(anchored.companyId).toBe('b'.repeat(64));
    expect(anchored.mismatch).toBe(false);
    // Every other standing withholds the company details and proposal list,
    // each saying why in its own words — a binding under any other key, or
    // one whose signer cannot be tied to the owner yet, anchors nothing.
    const warnings = new Set<string>();
    for (const standing of ['not-owner', 'owner-unknown', 'no-owner-key'] as const) {
      const s = companyScope(VOCAB_BINDING, policy, standing);
      expect(s.companyId, standing).toBeNull();
      expect(s.mismatch, standing).toBe(true);
      expect(s.warning, standing).toMatch(/not shown/i);
      warnings.add(s.warning ?? '');
    }
    expect(warnings.size).toBe(3);
    expect(companyScope(VOCAB_BINDING, policy, 'not-owner').warning).toMatch(/not signed by the room’s owner/i);
    expect(companyScope(VOCAB_BINDING, policy, 'owner-unknown').warning).toMatch(/does not yet know this room’s owner key/i);
    expect(companyScope(VOCAB_BINDING, policy, 'no-owner-key').warning).toMatch(/no keyed owner/i);
    // The binding passed alongside a non-owner standing is ignored, not
    // trusted by accident: with no policy either, nothing is known.
    expect(companyScope(VOCAB_BINDING, null, 'not-owner').companyId).toBeNull();
    // Anchored means the owner's binding named the company. The policy-alone
    // fallback still names one (an unbound room is allowed to show its
    // company) but says on screen what that rests on — every held state
    // withholds, so an empty slot is a hostile peer's cheapest arrangement.
    expect(anchored.anchored).toBe(true);
    expect(anchored.note).toBeNull();
    const fallback = companyScope(null, policy, 'absent');
    expect(fallback.companyId).toBe(policy.companyId);
    expect(fallback.anchored).toBe(false);
    expect(fallback.note).toMatch(/anyone in the room can write/i);
    expect(fallback.note).toMatch(/no funding record ties this company/i);
    expect(companyScope(null, null, 'absent').note).toBeNull();
    // And the phone prints it.
    const root = dirname(fileURLToPath(import.meta.url));
    const main = readFileSync(join(root, 'main.ts'), 'utf8');
    expect(main).toContain('scope.note ? dim(esc(scope.note)) : ""');
  });

  it('reads the owner key live from the room document, three ways', () => {
    // gamesDoc.readRoomOwnerKey is the seam: roomInfo.owner → players[owner].keyB64
    // today, the NFT-deed authority head under issue #138 tomorrow.
    const doc = new Y.Doc();
    bindGamesDoc(doc);
    expect(readRoomOwnerKey()).toEqual({ status: 'unknown' }); // nothing named
    doc.getMap('roomInfo').set('owner', 'player-1');
    expect(readRoomOwnerKey()).toEqual({ status: 'unknown' }); // entry not synced yet
    doc.getMap('players').set('player-1', { name: 'Ann' });
    expect(readRoomOwnerKey()).toEqual({ status: 'unknown' }); // entry without a key
    doc.getMap('players').set('player-1', { name: 'Ann', keyB64: 'k'.repeat(43) });
    // Provenance travels with the key: the room document is the only source
    // today, and it must say so rather than pass for a verified deed head.
    expect(readRoomOwnerKey()).toEqual({ status: 'known', pub: 'k'.repeat(43), source: 'room-doc' });
    // A rotated key takes effect on the next read, with no rebind.
    doc.getMap('players').set('player-1', { name: 'Ann', keyB64: 'z'.repeat(43) });
    expect(readRoomOwnerKey()).toEqual({ status: 'known', pub: 'z'.repeat(43), source: 'room-doc' });
    // The pre-keyed-identity marker can never have a key.
    doc.getMap('roomInfo').set('owner', 'Local-Clone');
    expect(readRoomOwnerKey()).toEqual({ status: 'legacy' });
  });

  it('wires the live owner key into both surfaces and repaints when it changes', () => {
    // Source-pinned because the wiring lives in main.ts and devices.ts. Both
    // surfaces must derive the signer from the SAME live reader, or the phone
    // and the terminal disagree about whose binding this is.
    const root = dirname(fileURLToPath(import.meta.url));
    const main = readFileSync(join(root, 'main.ts'), 'utf8');
    const devices = readFileSync(join(root, 'devices.ts'), 'utf8');
    const from = main.indexOf('function paintTreasuryBody(');
    const body = main.slice(from, main.indexOf('\nfunction ', from + 1));
    expect(body).toContain('const ownerKey = readRoomOwnerKey();');
    expect(body).toContain('bindingSigner(bindingResult.binding, ownerKey)');
    // Only the owner's binding reaches companyScope as an anchor.
    expect(body).toContain('standing === "owner" ? heldBinding : null');
    // The phone's funding view RECEIVES the live key. The parameter has an
    // honest default (owner unknown), so a dropped argument compiles and
    // leaves the suite green while the phone and the terminal disagree.
    const callAt = body.indexOf('const binding = roomFundingView(');
    expect(callAt).toBeGreaterThan(-1);
    const fundingCall = body.slice(callAt, body.indexOf(');', callAt));
    expect(fundingCall, 'phone funding view is not handed the live owner key').toContain('ownerKey');
    // The signer and the unchecked company half are rendered, not just
    // computed — and "Bound by" is reserved for the owner's own signature.
    expect(body).toContain('row(binding.signer === "owner" ? "Bound by" : "Signed by", esc(binding.signerLabel))');
    expect(body).toContain('row("Company approval", esc(binding.companyApproval))');
    // The terminal passes the same reader.
    // Bounded to the FUNDING refresh block — from its read to its write — so a
    // neighbour's code cannot satisfy the assertion by accident.
    const readAt = devices.indexOf('const bindingResult = connected ? readRoomBindingResult(roomId)');
    const writeAt = devices.indexOf('fundDetailEl.textContent', readAt);
    expect(readAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(readAt);
    const terminal = devices.slice(readAt, writeAt);
    expect(terminal).toContain('readRoomOwnerKey(),');
    expect(terminal).toContain("${funding.signer === 'owner' ? 'BOUND BY' : 'SIGNED BY'} ${(funding.signerLabel");
    expect(terminal).toContain('COMPANY APPROVAL ${(funding.companyApproval');
    expect(terminal).toContain('SIGNED BY ${funding.signerLabel');
    // And an owner change repaints: both maps the verdict reads from. Bounded
    // to each observer's closing brace, not a character window, so moving the
    // call within the observer cannot fail with a message claiming it is gone.
    for (const observer of ['roomMap.observe((_event) => {', 'playersMap.observe((_event) => {']) {
      const at = main.indexOf(observer);
      expect(at, `${observer} not found`).toBeGreaterThan(-1);
      const end = main.indexOf('\n  });', at);
      expect(end, `${observer} has no closing brace`).toBeGreaterThan(at);
      expect(main.slice(at, end), `${observer} does not repaint the treasury`)
        .toContain('queueTreasuryRepaint();');
    }
  });

  it('resets every piece of treasury navigation state at the room-join seam', () => {
    // The one behavioural edit in this change with no unit seam: a cursor is
    // a key in one document's key space and meant nothing in the next room.
    // Pinned here so the call cannot drift away from the bind, and so a reset
    // that forgets one of the ten variables is caught by name.
    const root = dirname(fileURLToPath(import.meta.url));
    const main = readFileSync(join(root, 'main.ts'), 'utf8');
    const bindAt = main.indexOf('bindTreasuryDoc(sync.doc, {');
    expect(bindAt, 'the join-seam bindTreasuryDoc call not found').toBeGreaterThan(-1);
    expect(main.slice(bindAt, bindAt + 1200)).toContain('resetTreasuryNavigation();');
    const fnAt = main.indexOf('function resetTreasuryNavigation(');
    expect(fnAt).toBeGreaterThan(-1);
    const fn = main.slice(fnAt, main.indexOf('\n}', fnAt));
    for (const v of [
      'treasuryDetailId', 'treasuryListCursors', 'treasuryApprovalCursors', 'treasuryVoteCursors',
      'treasuryCheckpointCursors', 'treasuryClassOffset',
      'lastListNext', 'lastVoteNext', 'lastCheckpointNext', 'lastApprovalNext',
    ]) {
      expect(fn, `${v} is not reset at the join seam`).toContain(`${v} =`);
    }
  });
});

describe('held-but-unreadable states added late', () => {
  // The UNREAD badges and "a record is held" headlines arrived in the last
  // review rounds and none of these branches had an assertion: a refactor
  // that dropped the too-large/unreadable guard would have left the badge
  // saying NO DATA beside a headline saying a record is here, with the suite
  // green. These are exactly the branches where badge and headline must agree.
  it('badges a funding record this device would not or could not read as UNREAD, not NO DATA', () => {
    for (const access of ['too-large', 'unreadable'] as const) {
      const v = roomFundingView(null, null, access);
      expect(v.bound).toBe(false);
      expect(v.trust.label).toBe('UNREAD');
      expect(v.trust.level).toBe('unverified');
      expect(v.headline).toMatch(/funding record/i);
      expect(v.headline).not.toMatch(/no company funding record|unavailable/i);
      expect(v.detail).toMatch(/not the same as there being no record|something is here/i);
    }
    // And the two recordless obstacles stay NO DATA with the no-lookup detail.
    for (const access of ['no-network', 'no-room'] as const) {
      const v = roomFundingView(null, null, access);
      expect(v.trust.level).toBe('absent');
      expect(v.trust.detail).toMatch(/no lookup was possible/i);
    }
  });

  it('badges a held-but-unreadable chain-view claim as UNREAD', () => {
    const held = syncView(null, true, true);
    expect(held.trust.label).toBe('UNREAD');
    expect(held.trust.level).toBe('unverified');
    expect(held.peerClaim).toBeNull();
    // Nothing written at all is the only state that earns NO DATA.
    expect(syncView(null, true, false).trust.level).toBe('absent');
    // A claim that read fine is unverified, like every other panel's data.
    const peer = { v: 1, networkGenesisChallenge: 'a'.repeat(64), state: 'degraded' } as ChainSyncStatus;
    expect(syncView(peer, true).trust.level).toBe('unverified');
    expect(syncView(peer, true).peerClaim).toBe('degraded');
  });

  it('does not describe an unreadable cached clock record as a mismatch', () => {
    // 'unreadable' from the reader covers a malformed value as well as a
    // misfiled one, so the note must not assert which proposal the bytes
    // describe — that is a claim about something this device never read.
    const subject = {
      ...(contracts.proposal.unsigned as object),
      proposalId: registration.proposalId,
      policyVersion: registration.policyVersion,
      kind: registration.kind,
      proposerSig: 'sig',
    } as TreasuryProposal;
    const unreadable = windowsView(subject, null, null, null, false, true);
    expect(unreadable.trust.level).toBe('unverified');
    expect(unreadable.note).toMatch(/copied set of clocks is held here/i);
    expect(unreadable.note).toMatch(/cannot make sense of it/i);
    expect(unreadable.note).not.toMatch(/different proposal or policy version/i);
    // A record that WAS read and names another proposal keeps the mismatch
    // wording — the two are different facts and stay worded apart.
    const other = { ...windows, proposalId: '9'.repeat(64) } as ProposalWindows;
    const mismatch = windowsView(subject, null, null, other);
    expect(mismatch.note).toMatch(/different proposal or policy version/i);
    expect(mismatch.note).not.toMatch(/cannot make sense of it/i);
  });
});

const PHASE_STRINGS = {
  noClocks: phaseLabel('no-clocks'),
  unknownHeight: phaseLabel('unknown-height'),
  voting: phaseLabel('voting'),
  veto: phaseLabel('veto'),
  timelock: phaseLabel('timelock'),
  executable: phaseLabel('executable'),
  expired: phaseLabel('expired'),
};

