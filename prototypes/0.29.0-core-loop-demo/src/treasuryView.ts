// treasuryView.ts — presentation logic for the READ-ONLY treasury UI (PR C).
//
// Pure functions only: takes records that came out of treasuryDoc's caches and
// returns display models. No DOM, no Yjs, no IO — main.ts paints the strings
// and devices.ts reuses the same models for the room terminal's FUNDING panel,
// so the honesty rules below are unit-testable away from a 7k-line file.
//
// THE HONESTY RULES THIS MODULE ENFORCES (plan §4.1, §11.1, §14; amendment §6):
//
//  1. Nothing here is authority. The browser may display balances and verify
//     proofs; it may not decide a balance, declare a proposal executable, or
//     treat a cache as settlement. Every model carries a TrustLevel saying how
//     much checking actually happened, because the cache layer validates each
//     record class differently (signature / self-address / shape only).
//  2. No invented numbers. There is no verified balance source until the node
//     treasury lane lands (PR D), so balances report WHY they are unavailable
//     instead of rendering a plausible zero.
//  3. Block height is authoritative; wall-clock is never shown as a deadline
//     (§7.1). A proposal's phase is only claimed when a height is available,
//     and it is labelled with where that height came from.
//  4. Player vocabulary (amendment §13): company, shares, board, approvals,
//     Registry, votes, receipts. The words singleton, CAT, vault and
//     checkpoint coin never reach any string this module returns.

import {
  type ChainSyncStatus,
} from './treasuryDoc';
import {
  type CompanyTreasuryPolicy,
  type GovernanceKindRule,
  type MojoString,
  type ProposalRegistration,
  type ProposalWindows,
  type RoomTreasuryBinding,
  type SigningSession,
  type TreasuryCheckpoint,
  type TreasuryProposal,
  type TreasuryProposalKind,
  type TreasuryVote,
  compareMojoStrings,
  deriveProposalWindows,
} from './treasuryTypes';

// ---------------------------------------------------------------------------
// Trust labelling
// ---------------------------------------------------------------------------

/** How much checking a displayed record actually received. */
export type TrustLevel = 'signed' | 'self-checked' | 'unverified' | 'absent';

export interface TrustTag {
  level: TrustLevel;
  /** Short badge text. */
  label: string;
  /** One line a player can read to know what the badge means. */
  detail: string;
}

const TRUST: Record<TrustLevel, Omit<TrustTag, 'level'>> = {
  signed: {
    label: 'SIGNED',
    detail: 'Signature checked on this device.',
  },
  'self-checked': {
    label: 'SELF-CHECKED',
    detail: 'Contents match their own fingerprint, recomputed here.',
  },
  unverified: {
    label: 'UNVERIFIED',
    detail: 'Shape only — anyone in the room can write this. The chain decides.',
  },
  absent: {
    label: 'NO DATA',
    detail: 'Nothing cached for this yet.',
  },
};

export function trustTag(level: TrustLevel): TrustTag {
  return { level, ...TRUST[level] };
}

// ---------------------------------------------------------------------------
// Amount formatting (there is no currency helper anywhere else in src/)
// ---------------------------------------------------------------------------

/** 1 XCH = 10^12 mojos. */
const MOJOS_PER_XCH_DIGITS = 12;
/** Plan §5.2: one whole share is 1000 share-asset mojos. */
const MOJOS_PER_SHARE_DIGITS = 3;

/**
 * Decimal-shifts a mojo string by `digits` places. Pure string work: a u64
 * mojo amount exceeds Number.MAX_SAFE_INTEGER, so parsing it as a number would
 * quietly corrupt large values.
 */
function shiftDecimal(mojos: MojoString, digits: number): string {
  const padded = mojos.padStart(digits + 1, '0');
  const whole = padded.slice(0, padded.length - digits);
  const frac = padded.slice(padded.length - digits).replace(/0+$/, '');
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac.length > 0 ? `${groupedWhole}.${frac}` : groupedWhole;
}

/** "1500000000000" -> "1.5 XCH". Only ever applied to the xch asset. */
export function formatXch(mojos: MojoString): string {
  return `${shiftDecimal(mojos, MOJOS_PER_XCH_DIGITS)} XCH`;
}

/** "2500" -> "2.5 shares" (plan §5.2). */
export function formatShares(mojos: MojoString): string {
  const shown = shiftDecimal(mojos, MOJOS_PER_SHARE_DIGITS);
  return `${shown} ${shown === '1' ? 'share' : 'shares'}`;
}

/**
 * Formats an amount for its asset. A non-xch asset is some other company
 * token, so it is never scaled or labelled as XCH — the raw amount is shown
 * against a shortened asset id instead of inventing a denomination.
 */
export function formatAmount(assetId: string, amount: MojoString): string {
  if (assetId === 'xch') return formatXch(amount);
  return `${amount} · asset ${shortId(assetId)}`;
}

/** Middle-truncates a 64-hex id for display: "ab12cd…7f90". */
export function shortId(hex: string, keep = 6): string {
  if (hex.length <= keep * 2 + 1) return hex;
  return `${hex.slice(0, keep)}…${hex.slice(-4)}`;
}

/** Block heights are the authoritative clock — always shown as heights. */
export function formatHeight(height: number): string {
  return `#${height.toLocaleString('en-US')}`;
}

// ---------------------------------------------------------------------------
// Proposal kinds and phases (player vocabulary)
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<TreasuryProposalKind, string> = {
  pay: 'Payment',
  budget: 'Budget',
  'appoint-manager': 'Appoint manager',
  'revoke-manager': 'Revoke manager',
  'bind-room': 'Fund a room',
  'change-policy': 'Change policy',
  'rotate-board': 'Rotate board',
  'add-share-class': 'Add share class',
  dissolve: 'Dissolve company',
};

export function proposalKindLabel(kind: TreasuryProposalKind): string {
  return KIND_LABELS[kind] ?? kind;
}

/** The §15 status vocabulary, minus the states only the chain can report. */
export type ProposalPhase =
  | 'unknown-height'
  | 'voting'
  | 'veto'
  | 'timelock'
  | 'executable'
  | 'expired';

const PHASE_LABELS: Record<ProposalPhase, string> = {
  'unknown-height': 'Clocks known · position unknown',
  voting: 'Voting open',
  veto: 'Veto window',
  timelock: 'Waiting out the delay',
  executable: 'Ready for the board',
  expired: 'Expired',
};

export function phaseLabel(phase: ProposalPhase): string {
  return PHASE_LABELS[phase];
}

/**
 * Where the height used to place a proposal on its clocks came from. There is
 * no locally verified chain height until PR D, so the UI must never present a
 * phase as settled fact.
 */
export type HeightSource = 'none' | 'peer-reported';

/**
 * Places a proposal on its clocks. Returns 'unknown-height' unless a height is
 * supplied — with no chain view, refusing to claim a phase is the honest
 * answer (invariant 10: when authoritative state cannot be reached, stop).
 */
export function proposalPhase(
  windows: ProposalWindows,
  currentHeight: number | null,
): ProposalPhase {
  if (currentHeight === null) return 'unknown-height';
  if (currentHeight >= windows.expiresAfterHeight) return 'expired';
  if (currentHeight >= windows.executableFromHeight) return 'executable';
  if (currentHeight >= windows.vetoEndsHeight) return 'timelock';
  if (currentHeight >= windows.votingEndsHeight) return 'veto';
  return 'voting';
}

// ---------------------------------------------------------------------------
// Window derivation (recompute to trust — amendment §4)
// ---------------------------------------------------------------------------

export interface WindowsView {
  windows: ProposalWindows | null;
  /**
   * recomputed — derived here from the registration and the policy rule;
   * cached — a peer's copy, shown because we cannot recompute it;
   * none — no registration cached, so the proposal has no clocks yet.
   */
  source: 'recomputed' | 'cached' | 'none';
  trust: TrustTag;
  note: string;
}

/**
 * Recomputes a proposal's clocks rather than trusting the cached copy. Even a
 * clean recomputation only proves internal consistency: the registration it
 * derives from is an unverified cache entry until the node confirms the
 * registration on chain, which is why the trust tag never says "signed".
 */
export function windowsView(
  registration: ProposalRegistration | null,
  rule: GovernanceKindRule | null,
  cached: ProposalWindows | null,
): WindowsView {
  if (registration && rule) {
    try {
      return {
        windows: deriveProposalWindows(registration, rule),
        source: 'recomputed',
        trust: trustTag('self-checked'),
        note: 'Recomputed here from the accepted height and the company policy.',
      };
    } catch {
      return {
        windows: null,
        source: 'none',
        trust: trustTag('absent'),
        note: 'The cached acceptance record and policy do not produce valid clocks.',
      };
    }
  }
  if (cached) {
    return {
      windows: cached,
      source: 'cached',
      trust: trustTag('unverified'),
      note: registration
        ? 'Company policy is not cached, so these clocks could not be recomputed.'
        : 'No acceptance record cached, so these clocks could not be recomputed.',
    };
  }
  return {
    windows: null,
    source: 'none',
    trust: trustTag('absent'),
    note: 'This proposal has not been accepted on chain yet.',
  };
}

// ---------------------------------------------------------------------------
// Votes and vote confirmation (amendment §5)
// ---------------------------------------------------------------------------

export interface VoteTallyView {
  /** Signature-verified votes held in this room's cache. */
  held: number;
  yes: number;
  no: number;
  abstain: number;
  veto: number;
  /** Confirmed vote-confirmation records covering this proposal. */
  confirmedRecords: number;
  /** Records published but not yet confirmed on chain. */
  pendingRecords: number;
  /**
   * True when no confirmed record exists — under the amendment's rule a vote
   * in no confirmed record does not count, however many are held locally.
   */
  noneCount: boolean;
  note: string;
}

/**
 * Summarises what this room's cache holds. Deliberately NOT a tally: counting
 * requires chain-verified share balances at the snapshot height and the union
 * across confirmed vote-confirmation records, neither of which the browser can
 * see. The count is described as "held here", never as a result.
 */
export function voteTallyView(
  votes: TreasuryVote[],
  checkpoints: TreasuryCheckpoint[],
): VoteTallyView {
  const tally = { yes: 0, no: 0, abstain: 0, veto: 0 };
  for (const v of votes) tally[v.choice] += 1;
  const confirmedRecords = checkpoints.filter(
    (c) => typeof c.confirmedHeight === 'number',
  ).length;
  const pendingRecords = checkpoints.length - confirmedRecords;
  const noneCount = confirmedRecords === 0;
  return {
    held: votes.length,
    ...tally,
    confirmedRecords,
    pendingRecords,
    noneCount,
    note: noneCount
      ? 'No confirmed vote record yet — votes only count once one is confirmed on chain.'
      : 'Final counting happens against confirmed records and share balances on chain.',
  };
}

// ---------------------------------------------------------------------------
// Board approvals (amendment §7 — signatures are unverifiable here)
// ---------------------------------------------------------------------------

export interface ApprovalsView {
  sessions: number;
  /** Highest collected count across sessions — unverified by construction. */
  collected: number;
  required: number;
  note: string;
}

/**
 * Board approval progress. The collected count is unverified: board signatures
 * cannot be checked in the browser until the custody primitive lands (PR F),
 * so a peer could inflate it. The note says so rather than implying progress.
 */
export function approvalsView(sessions: SigningSession[]): ApprovalsView {
  let collected = 0;
  let required = 0;
  for (const s of sessions) {
    if (s.collectedSigs.length > collected) collected = s.collectedSigs.length;
    if (s.requiredThreshold > required) required = s.requiredThreshold;
  }
  return {
    sessions: sessions.length,
    collected,
    required,
    note: sessions.length === 0
      ? 'No approval round open.'
      : 'Approval counts are not verified in the phone — the chain enforces the threshold.',
  };
}

// ---------------------------------------------------------------------------
// Balances (§11.1) — the honest unavailable state
// ---------------------------------------------------------------------------

export interface BalanceView {
  available: false;
  headline: string;
  detail: string;
}

/**
 * §11.1 asks for verified balances by asset. Nothing in the browser can
 * produce one: balances come from the chain through the player's own node,
 * which arrives with the node treasury lane. Showing a zero, or a cached
 * number from a peer, would be exactly the invented authority invariant 5
 * forbids — so this reports its own absence.
 */
export function balanceView(): BalanceView {
  return {
    available: false,
    headline: 'No verified balance yet',
    detail: 'Balances are read from the chain by your own node. Until that lane ships, the phone will not show a number it cannot verify.',
  };
}

// ---------------------------------------------------------------------------
// Chain sync (display-only — treasuryDoc warns this key is peer-writable)
// ---------------------------------------------------------------------------

export interface SyncView {
  /** The LOCAL verdict. Always 'unavailable' until the node lane lands. */
  localState: 'unavailable';
  localNote: string;
  /** A peer's claim, shown as hearsay and never used as a gate. */
  peerClaim: string | null;
  peerHeight: number | null;
}

/**
 * Offline/read-only state is each node's own verdict (amendment §6/§15.3), and
 * the shared sync key is peer-writable, so it is rendered as a claim rather
 * than a status. With no local chain view the local verdict is 'unavailable':
 * the UI is read-only and says why.
 */
export function syncView(peer: ChainSyncStatus | null): SyncView {
  return {
    localState: 'unavailable',
    localNote: 'This device is not verifying the chain yet, so nothing here is final and no spending is possible from the phone.',
    peerClaim: peer ? peer.state : null,
    peerHeight: peer && typeof peer.verifiedHeight === 'number' ? peer.verifiedHeight : null,
  };
}

/**
 * The height used to place proposals on their clocks, with its provenance.
 * Only a peer-reported height exists today, so a phase derived from it is
 * labelled accordingly and never drives an action.
 */
export function displayHeight(peer: ChainSyncStatus | null): {
  height: number | null;
  source: HeightSource;
} {
  if (peer && typeof peer.verifiedHeight === 'number') {
    return { height: peer.verifiedHeight, source: 'peer-reported' };
  }
  return { height: null, source: 'none' };
}

// ---------------------------------------------------------------------------
// Policy / board / shares / room funding
// ---------------------------------------------------------------------------

export interface BoardView {
  threshold: number;
  signers: number;
  policyVersion: number;
  maxFee: string;
  trust: TrustTag;
  note: string;
}

/** Policy is a shape-checked cache — any peer can replace it (treasuryDoc). */
export function boardView(policy: CompanyTreasuryPolicy): BoardView {
  return {
    threshold: policy.board.threshold,
    signers: policy.board.signerPuzzleHashes.length,
    policyVersion: policy.policyVersion,
    maxFee: formatXch(policy.maxFeeMojos),
    trust: trustTag('unverified'),
    note: 'Compare this policy fingerprint against the chain before trusting it.',
  };
}

export interface ShareClassView {
  id: string;
  votesPerWholeShare: number;
  grantsRoomAccess: boolean;
  transferable: boolean;
}

/** §11.4: classes are readable, creation stays out of the UI. */
export function shareClassViews(policy: CompanyTreasuryPolicy): ShareClassView[] {
  return policy.shareClasses.map((c) => ({
    id: c.id,
    votesPerWholeShare: c.votesPerWholeShare,
    grantsRoomAccess: c.grantsRoomAccess,
    transferable: c.transferable,
  }));
}

export interface RoomFundingView {
  bound: boolean;
  companyId: string | null;
  policyVersion: number | null;
  boundAtHeight: number | null;
  expiresAfterHeight: number | null;
  trust: TrustTag;
  headline: string;
  detail: string;
}

/**
 * The room terminal's FUNDING panel and the phone's room line share this.
 * A binding is signed by whoever bound it, which the cache verifies — but
 * §10.1's rule stands: appearing in the room document does not make it
 * authoritative, and funding never implies edit rights (§9.4).
 */
export function roomFundingView(binding: RoomTreasuryBinding | null): RoomFundingView {
  if (!binding) {
    return {
      bound: false,
      companyId: null,
      policyVersion: null,
      boundAtHeight: null,
      expiresAfterHeight: null,
      trust: trustTag('absent'),
      headline: 'Personal funding',
      detail: 'This room is not funded by a company. Its costs come from the owner personally.',
    };
  }
  return {
    bound: true,
    companyId: binding.companyId,
    policyVersion: binding.policyVersion,
    boundAtHeight: binding.boundAtHeight,
    expiresAfterHeight: binding.expiresAfterHeight ?? null,
    trust: trustTag('signed'),
    headline: 'Company funding',
    detail: 'Funding this room does not grant anyone edit rights here — those stay separate.',
  };
}

// ---------------------------------------------------------------------------
// Proposal list rows
// ---------------------------------------------------------------------------

export interface ProposalRowView {
  proposalId: string;
  shortId: string;
  kindLabel: string;
  policyVersion: number;
  phase: ProposalPhase;
  phaseLabel: string;
  heightSource: HeightSource;
}

/**
 * Sorts by acceptance height where known (newest first), then by id so the
 * order is stable across repaints regardless of map iteration order.
 */
export function proposalRows(
  proposals: TreasuryProposal[],
  windowsFor: (proposalId: string) => ProposalWindows | null,
  currentHeight: number | null,
  heightSource: HeightSource,
): ProposalRowView[] {
  const rows = proposals.map((p) => {
    const w = windowsFor(p.proposalId);
    const phase = w ? proposalPhase(w, currentHeight) : 'unknown-height';
    return {
      proposalId: p.proposalId,
      shortId: shortId(p.proposalId),
      kindLabel: proposalKindLabel(p.kind),
      policyVersion: p.policyVersion,
      phase,
      phaseLabel: phaseLabel(phase),
      heightSource,
      _accepted: w ? w.acceptedHeight : -1,
    };
  });
  rows.sort((a, b) => {
    if (a._accepted !== b._accepted) return b._accepted - a._accepted;
    return a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0;
  });
  return rows.map(({ _accepted, ...row }) => {
    void _accepted;
    return row;
  });
}

/** Largest allowance bound first — uses the no-parse mojo comparator. */
export function sortByAmountDesc<T>(items: T[], amountOf: (item: T) => MojoString): T[] {
  return [...items].sort((a, b) => compareMojoStrings(amountOf(b), amountOf(a)));
}
