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
import contracts from '../test-vectors/treasury/treasury-contracts.json';
import {
  approvalsView,
  balanceView,
  boardView,
  displayHeight,
  formatAmount,
  formatHeight,
  formatShares,
  boardThresholdFor,
  checkpointsFor,
  companyScope,
  formatXch,
  governanceRuleFor,
  payloadView,
  phaseLabel,
  sessionsFor,
  proposalKindLabel,
  proposalPhase,
  proposalRows,
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
    const kept = sessionsFor(
      [
        mine,
        round({ companyId: '9'.repeat(64) }),
        round({ policyVersion: proposal.policyVersion + 1 }),
        round({ proposalId: '9'.repeat(64) }),
      ],
      proposal,
    );
    expect(kept).toEqual([mine]);
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
    const s = companyScope(binding('a'.repeat(64)), { ...policy, companyId: 'b'.repeat(64) });
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
    });
    expect(s.mismatch).toBe(true);
    expect(s.companyId).toBeNull();
  });

  it('uses the agreed company, or whichever one is known', () => {
    const agreed = companyScope(binding(policy.companyId), policy);
    expect(agreed.mismatch).toBe(false);
    expect(agreed.companyId).toBe(policy.companyId);
    expect(companyScope(null, policy).companyId).toBe(policy.companyId);
    expect(companyScope(binding('e'.repeat(64)), null).companyId).toBe('e'.repeat(64));
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
    const held = payloadView(true);
    expect(held.present).toBe(true);
    expect(held.headline).toMatch(/held in this room/i);
    // The cache only returns payload bytes whose hash it recomputed, so this
    // is the one genuinely self-checked panel — and it must say so.
    expect(held.trust.level).toBe('self-checked');
    const missing = payloadView(false);
    expect(missing.present).toBe(false);
    expect(missing.trust.level).toBe('absent');
    expect(missing.detail).toMatch(/cannot be shown/i);
    for (const s of [held.headline, held.detail, missing.headline, missing.detail]) {
      expect(s).not.toMatch(/[0-9a-f]{16,}/); // never raw hex at the player
    }
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
    const peer: ChainSyncStatus = { v: 1, state: 'verified', verifiedHeight: 5_000_000 };
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
    expect(displayHeight({ v: 1, state: 'degraded', verifiedHeight: 42 })).toEqual({
      height: 42,
      source: 'peer-reported',
    });
    // A status with no height cannot supply one.
    expect(displayHeight({ v: 1, state: 'unavailable' }).height).toBeNull();
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
    expect(classes).toHaveLength(1);
    expect(classes[0].id).toBe('common');
    expect(Object.keys(classes[0])).toEqual([
      'id', 'votesPerWholeShare', 'grantsRoomAccess', 'transferable',
    ]);
  });

  it('distinguishes "cannot read" from "no record exists"', () => {
    // A read that cannot run is not evidence of absence — the terminal used
    // to report an unconfigured build as "no company funding record".
    const disabled = roomFundingView(null, null, false);
    expect(disabled.headline).toMatch(/unavailable/i);
    expect(disabled.detail).toMatch(/not set up to read/i);
    expect(disabled.headline).not.toMatch(/no company funding record/i);
    const readableButEmpty = roomFundingView(null, null, true);
    expect(readableButEmpty.headline).toMatch(/no company funding record/i);
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
    const bound = roomFundingView(binding);
    expect(bound.bound).toBe(true);
    expect(bound.policyVersion).toBe(2);
    expect(bound.trust.level).toBe('signed');
    expect(bound.detail).toMatch(/edit rights/i);
    expect(bound.profileId).toBe('p1');
    expect(bound.treasuryId).toBe('c'.repeat(64));
    // A signature says who wrote it — never that they were entitled to.
    expect(bound.trust.detail).toMatch(/not that they were allowed to/i);
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
    const banned = /\b(singleton|vault|checkpoint coin|mojo)\b|\bCAT\b/i;
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
      voteTallyView([], []).note,
      voteTallyView([], []).caveat,
      approvalsView([], null).note,
      payloadView(true).headline,
      payloadView(true).detail,
      payloadView(false).detail,
      windowsView(subject, registration, rule, null).note,
      windowsView(subject, null, null, null).note,
      windowsView(subject, null, null, windows).note,
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

  it('keeps banned jargon out of the treasury UI source itself', () => {
    // The view module is only half the surface: the strings a player actually
    // reads are literals in the render function, the terminal panel and the
    // markup. Scan those directly, scoped to the treasury code.
    const banned = /\b(singleton|vault|checkpoint coin)\b|\bCAT\b/i;
    const root = dirname(fileURLToPath(import.meta.url));
    const treasuryBlocks: { where: string; text: string }[] = [];
    const push = (where: string, text: string) => treasuryBlocks.push({ where, text });
    push('treasuryView.ts', readFileSync(join(root, 'treasuryView.ts'), 'utf8'));
    push('treasuryNetwork.ts', readFileSync(join(root, 'treasuryNetwork.ts'), 'utf8'));
    // main.ts: just the treasury render function.
    // paintTreasuryApp, NOT renderTreasuryApp: the latter is only the
    // focus-preserving wrapper, so slicing from it would scan none of the
    // player-visible markup this guard exists to cover.
    const main = readFileSync(join(root, 'main.ts'), 'utf8');
    const start = main.indexOf('function paintTreasuryApp');
    const end = main.indexOf('\nfunction ', start + 1);
    expect(start, 'paintTreasuryApp not found — did the render split change?')
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
    push('devices.ts refresh block', devices.slice(first - 600, first + 2500));
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

const PHASE_STRINGS = {
  noClocks: phaseLabel('no-clocks'),
  unknownHeight: phaseLabel('unknown-height'),
  voting: phaseLabel('voting'),
  veto: phaseLabel('veto'),
  timelock: phaseLabel('timelock'),
  executable: phaseLabel('executable'),
  expired: phaseLabel('expired'),
};

