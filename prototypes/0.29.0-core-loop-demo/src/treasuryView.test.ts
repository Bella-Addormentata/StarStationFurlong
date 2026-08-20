// treasuryView tests: the honesty rules the read-only treasury UI depends on —
// u64-safe amount formatting, phase claims only when a height exists,
// recompute-to-trust window derivation, "held" vote counts that never present
// themselves as a tally, and the plan's player-vocabulary ban.

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
  formatXch,
  phaseLabel,
  proposalKindLabel,
  proposalPhase,
  proposalRows,
  roomFundingView,
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
  it('recomputes rather than trusting the cached copy', () => {
    const v = windowsView(registration, rule, null);
    expect(v.source).toBe('recomputed');
    expect(v.windows).toEqual(deriveProposalWindows(registration, rule));
    expect(v.trust.level).toBe('self-checked');
  });

  it('ignores a tampered cache when it can recompute', () => {
    const tampered = { ...windows, expiresAfterHeight: windows.expiresAfterHeight + 999 };
    const v = windowsView(registration, rule, tampered);
    expect(v.windows?.expiresAfterHeight).toBe(windows.expiresAfterHeight);
  });

  it('falls back to the cached copy, marked unverified, when it cannot recompute', () => {
    const v = windowsView(null, null, windows);
    expect(v.source).toBe('cached');
    expect(v.trust.level).toBe('unverified');
  });

  it('reports absence rather than throwing on malformed inputs', () => {
    const bad = { ...registration, acceptedHeight: -1 } as ProposalRegistration;
    const v = windowsView(bad, rule, null);
    expect(v.source).toBe('none');
    expect(v.windows).toBeNull();
    expect(windowsView(null, null, null).trust.level).toBe('absent');
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
    expect(t.confirmedRecords).toBe(1);
    expect(t.noneCount).toBe(false);
    expect(t.note).toMatch(/chain/i);
  });

  it('flags that nothing counts without a confirmed record', () => {
    const t = voteTallyView([vote('yes', '1'.repeat(64))], [checkpoint(false)]);
    expect(t.held).toBe(1);
    expect(t.confirmedRecords).toBe(0);
    expect(t.pendingRecords).toBe(1);
    expect(t.noneCount).toBe(true);
    expect(t.note).toMatch(/only count/i);
  });

  it('marks board approval counts as unverified', () => {
    const session: SigningSession = {
      v: 1,
      sessionId: 'a'.repeat(64),
      networkGenesisChallenge: 'a'.repeat(64),
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      proposalId: 'c'.repeat(64),
      bundleHash: 'd'.repeat(64),
      requiredThreshold: 3,
      collectedSigs: [{ signerPuzzleHash: 'e'.repeat(64), sig: 's' }],
      expiresAfterHeight: 100,
    };
    const a = approvalsView([session]);
    expect(a.collected).toBe(1);
    expect(a.required).toBe(3);
    expect(a.note).toMatch(/not verified/i);
    expect(approvalsView([]).note).toMatch(/No approval round/i);
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
    expect(syncView(null).peerClaim).toBeNull();
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

  it('separates company funding from edit rights, and handles the unbound room', () => {
    const unbound = roomFundingView(null);
    expect(unbound.bound).toBe(false);
    expect(unbound.headline).toMatch(/personal/i);
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
    const rows = proposalRows(
      [proposal('c'.repeat(64), 'pay'), proposal('a'.repeat(64), 'dissolve'), proposal('b'.repeat(64), 'budget')],
      (id) => (id.startsWith('c') ? { ...windows, acceptedHeight: 10 } : id.startsWith('b') ? { ...windows, acceptedHeight: 20 } : null),
      null,
      'none',
    );
    expect(rows.map((r) => r.proposalId[0])).toEqual(['b', 'c', 'a']);
    expect(rows[0].kindLabel).toBe('Budget');
    expect(rows.every((r) => r.phase === 'unknown-height')).toBe(true);
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
      voteTallyView([], [{ ...(contracts.checkpoint.body as object), checkpointId: 'x', confirmedHeight: 1 } as TreasuryCheckpoint]).note,
      approvalsView([]).note,
      windowsView(registration, rule, null).note,
      windowsView(null, null, null).note,
      windowsView(null, null, windows).note,
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
});

const PHASE_STRINGS = {
  unknownHeight: phaseLabel('unknown-height'),
  voting: phaseLabel('voting'),
  veto: phaseLabel('veto'),
  timelock: phaseLabel('timelock'),
  executable: phaseLabel('executable'),
  expired: phaseLabel('expired'),
};
