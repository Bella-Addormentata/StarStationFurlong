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
    // Deliberately modest: a signature proves WHO wrote the record, never
    // that they were entitled to. Authority is a chain question.
    detail: 'Signed by its author, and that signature was checked here — which shows who wrote it, not that they were allowed to.',
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
  | 'no-clocks'
  | 'unknown-height'
  | 'voting'
  | 'veto'
  | 'timelock'
  | 'executable'
  | 'expired';

const PHASE_LABELS: Record<ProposalPhase, string> = {
  // Neutral on purpose: clocks are also missing when the acceptance record IS
  // held but the matching policy is not, so "not accepted yet" would state a
  // chain fact this device has no basis for.
  'no-clocks': 'Clocks unavailable',
  'unknown-height': 'Clocks known · position unknown',
  voting: 'Voting open',
  veto: 'Veto window',
  timelock: 'Waiting out the delay',
  // Never "executable": §4.1 forbids the browser declaring a proposal
  // executable, and the chain enforces the window regardless of this label.
  executable: 'Inside the board’s window',
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
  // A height BEFORE the acceptance block means the two peer-written inputs
  // disagree: the chain cannot be at a point where this proposal both exists
  // and has not been accepted. Claiming "Voting open" there would invent a
  // phase out of an inconsistency, so report the position as unknown.
  if (currentHeight < windows.acceptedHeight) return 'unknown-height';
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
/**
 * Records that claim to belong to a proposal but describe a different one.
 * The cache keys registrations and cached windows by proposal id alone, so a
 * peer can file one whose kind or policy revision disagrees with the proposal
 * it sits under; splicing that with the proposal's own rule would produce
 * clocks for a rulebook the proposal never answered to.
 */
function registrationMatches(
  registration: ProposalRegistration,
  proposal: TreasuryProposal,
): boolean {
  return registration.proposalId === proposal.proposalId
    && registration.policyVersion === proposal.policyVersion
    && registration.kind === proposal.kind;
}

function cachedWindowsMatch(
  cached: ProposalWindows,
  proposal: TreasuryProposal,
): boolean {
  return cached.proposalId === proposal.proposalId
    && cached.policyVersion === proposal.policyVersion;
}

export function windowsView(
  proposal: TreasuryProposal,
  registrationRaw: ProposalRegistration | null,
  rule: GovernanceKindRule | null,
  cachedRaw: ProposalWindows | null,
): WindowsView {
  const registration =
    registrationRaw && registrationMatches(registrationRaw, proposal)
      ? registrationRaw
      : null;
  const cached =
    cachedRaw && cachedWindowsMatch(cachedRaw, proposal) ? cachedRaw : null;
  if (registration && rule) {
    try {
      return {
        windows: deriveProposalWindows(registration, rule),
        source: 'recomputed',
        // NOT 'self-checked': recomputing is better than trusting a peer's
        // copy, but both inputs — the acceptance record and the policy — are
        // shape-only caches anyone in the room can write. Claiming a higher
        // trust level here would rank the fully peer-controlled path above
        // the cached one it replaced.
        trust: trustTag('unverified'),
        note: 'Worked out here from the acceptance record and the company policy — neither of which this device has checked against the chain.',
      };
    } catch {
      return {
        windows: null,
        source: 'none',
        trust: trustTag('absent'),
        note: 'The acceptance record and policy held here do not produce sensible clocks.',
      };
    }
  }
  if (cached) {
    return {
      windows: cached,
      source: 'cached',
      trust: trustTag('unverified'),
      note: registration
        ? 'Copied from another player: the company policy is missing here, so these clocks could not be worked out independently.'
        : 'Copied from another player: no acceptance record is held here, so these clocks could not be worked out independently.',
    };
  }
  return {
    windows: null,
    source: 'none',
    trust: trustTag('absent'),
    note: registration
      ? 'The company policy is missing here, so this proposal’s clocks cannot be worked out.'
      : 'No acceptance record for this proposal is held in this room yet.',
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
  /** Vote-confirmation records held here, confirmed or not. */
  records: number;
  trust: TrustTag;
  note: string;
  /** Why these counts are not a result. Rendered alongside, never omitted. */
  caveat: string;
}

/**
 * Summarises what this room's cache holds. Deliberately NOT a tally, and the
 * caveat is unconditional rather than data-driven, because every input a
 * softer message could key off is attacker-controlled:
 *
 *  - a record's confirmation fields (confirmedHeight / the coin id) are
 *    excluded from its own fingerprint and it carries no signature, so a peer
 *    can mint "confirmed" freely. Reporting a confirmed COUNT would let that
 *    peer both fabricate reassurance and switch off the warning about it.
 *  - votes are per-keypair, so counts are inflatable, and weight comes from
 *    share balances at the snapshot height, which the browser cannot read.
 *  - the cache holds one record per voter slot, so a merge across a partition
 *    can surface the losing vote and hide the winner.
 *
 * So: counts are labelled as what is HELD HERE, and the caveat always says
 * the real count happens elsewhere.
 */
export function voteTallyView(
  votes: TreasuryVote[],
  checkpoints: TreasuryCheckpoint[],
): VoteTallyView {
  const tally = { yes: 0, no: 0, abstain: 0, veto: 0 };
  for (const v of votes) tally[v.choice] += 1;
  return {
    held: votes.length,
    ...tally,
    records: checkpoints.length,
    trust: trustTag('unverified'),
    note: 'Votes held in this room, one per voter — not a count, and not weighted by shares.',
    caveat: 'A vote only counts once it is inside a vote record confirmed on chain, which this device cannot check. Some votes may also be held by players who are not here.',
  };
}

// ---------------------------------------------------------------------------
// Board approvals (amendment §7 — signatures are unverifiable here)
// ---------------------------------------------------------------------------

export interface ApprovalsView {
  sessions: number;
  /** Signatures gathered in the furthest-along single round. */
  collected: number;
  /**
   * How many that round needs. Taken from the company policy when it is
   * known, because the round's own copy is written by whoever opened it.
   */
  required: number | null;
  requiredFromPolicy: boolean;
  trust: TrustTag;
  note: string;
}

/**
 * Board approval progress for ONE round — never a figure assembled from two.
 * Collected and required used to be independent maxima across all rounds,
 * which could pair a count from one round with a threshold from another and
 * report a total that no round had reached.
 *
 * Both numbers stay unverified: board signatures cannot be checked in the
 * browser until the custody primitive lands, so a peer can add arbitrary
 * strings to a round, and a round's own threshold is peer-authored — which is
 * why the policy's threshold is preferred when it is available.
 */
export function approvalsView(
  sessions: SigningSession[],
  policyThreshold: number | null,
  currentHeight: number | null = null,
): ApprovalsView {
  // Rounds stay in the cache after they end, so picking purely by signature
  // count would let a dead round with more signatures hide a live one and
  // read as current progress.
  const live =
    currentHeight === null
      ? sessions
      : sessions.filter((s) => currentHeight < s.expiresAfterHeight);
  const expired = sessions.length - live.length;
  let best: SigningSession | null = null;
  for (const s of live) {
    if (!best || s.collectedSigs.length > best.collectedSigs.length) best = s;
  }
  const required = policyThreshold ?? best?.requiredThreshold ?? null;
  const staleness =
    currentHeight === null
      ? sessions.length > 0
        ? ' Whether these rounds are still open cannot be judged without a chain height.'
        : ''
      : expired > 0
        ? ` ${expired} round${expired === 1 ? '' : 's'} already past its end height ${expired === 1 ? 'is' : 'are'} left out.`
        : '';
  return {
    sessions: live.length,
    collected: best ? best.collectedSigs.length : 0,
    required,
    requiredFromPolicy: policyThreshold !== null,
    trust: trustTag('unverified'),
    note:
      (live.length === 0
        ? 'No approval round open in this room.'
        : 'Approvals are not checked in the phone — the chain enforces the board’s threshold when a spend is made.') + staleness,
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
    // The fingerprint is shown in full: a shortened one cannot establish that
    // two hashes are equal, and this line asks the player to check exactly
    // that.
    note: 'Compare every character of this fingerprint against the chain before trusting it.',
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
  /** True when a binding exists but its own expiry height has passed. */
  lapsed: boolean;
  companyId: string | null;
  treasuryId: string | null;
  profileId: string | null;
  policyVersion: number | null;
  boundAtHeight: number | null;
  expiresAfterHeight: number | null;
  trust: TrustTag;
  headline: string;
  detail: string;
  /** Always rendered: this device does not check the chain (§10.2). */
  readOnlyNote: string;
  /** §10.2 rows nothing can supply yet, named instead of quietly dropped. */
  unavailable: string[];
}

/**
 * The room terminal's FUNDING panel and the phone's room line share this.
 *
 * Absence is reported as absence: with no binding cached, this device knows
 * nothing about how the room is funded, which is not the same as knowing the
 * room is funded personally. §10.1's rule also stands — appearing in the room
 * document does not make a binding authoritative — and funding never implies
 * edit rights (§9.4).
 */
export function roomFundingView(
  binding: RoomTreasuryBinding | null,
  currentHeight: number | null = null,
  /**
   * False when treasury reads are switched off (no network configured, or no
   * room document). A read that cannot run is NOT evidence that no record
   * exists, so it must not be reported as one.
   */
  readable = true,
): RoomFundingView {
  const readOnlyNote = 'Read-only: this device does not check the chain, so none of this is confirmed.';
  const unavailable = [
    'Covered systems and remaining budgets',
    'Any pending request to bind or unbind',
  ];
  if (!readable) {
    return {
      bound: false,
      lapsed: false,
      companyId: null,
      treasuryId: null,
      profileId: null,
      policyVersion: null,
      boundAtHeight: null,
      expiresAfterHeight: null,
      trust: trustTag('absent'),
      headline: 'Funding records unavailable',
      detail: 'This device is not set up to read company records, so it cannot say how this room is funded either way.',
      readOnlyNote,
      unavailable,
    };
  }
  if (!binding) {
    return {
      bound: false,
      lapsed: false,
      companyId: null,
      treasuryId: null,
      profileId: null,
      policyVersion: null,
      boundAtHeight: null,
      expiresAfterHeight: null,
      trust: trustTag('absent'),
      headline: 'No company funding record',
      // Says only what is known. Inferring that costs therefore fall to the
      // owner would be the same absence-as-fact mistake in slower words.
      detail: 'This room holds no record of a company funding it. That is not the same as knowing there is none.',
      readOnlyNote,
      unavailable,
    };
  }
  const expires = binding.expiresAfterHeight ?? null;
  const lapsed =
    expires !== null && currentHeight !== null && currentHeight >= expires;
  return {
    bound: true,
    lapsed,
    companyId: binding.companyId,
    treasuryId: binding.treasuryLauncherId,
    profileId: binding.profileId,
    policyVersion: binding.policyVersion,
    boundAtHeight: binding.boundAtHeight,
    expiresAfterHeight: expires,
    trust: trustTag('signed'),
    headline: lapsed ? 'Company funding · lapsed' : 'Company funding',
    detail: lapsed
      ? 'This record’s own end height has passed, so it no longer claims to fund the room. Funding a room grants nobody edit rights here — those stay separate.'
      : 'Funding this room does not grant anyone edit rights here — those stay separate.',
    readOnlyNote,
    unavailable,
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
  /**
   * How much the clocks behind this row's phase can be trusted. Carried per
   * row so the list can badge it: a phase label derived from a peer-copied
   * cache should not look like one worked out from a matching record.
   */
  clockTrust: TrustTag;
}

/**
 * Sorts by acceptance height where known (newest first), then by id so the
 * order is stable across repaints regardless of map iteration order.
 */
export function proposalRows(
  proposals: TreasuryProposal[],
  /**
   * Receives the whole proposal so callers need not re-read (and re-verify)
   * it, and returns the full view so each row keeps its clocks' trust tag.
   */
  windowsFor: (proposal: TreasuryProposal) => WindowsView,
  currentHeight: number | null,
  heightSource: HeightSource,
): ProposalRowView[] {
  const rows = proposals.map((p) => {
    const view = windowsFor(p);
    const w = view.windows;
    const phase: ProposalPhase = w ? proposalPhase(w, currentHeight) : 'no-clocks';
    return {
      proposalId: p.proposalId,
      shortId: shortId(p.proposalId),
      kindLabel: proposalKindLabel(p.kind),
      policyVersion: p.policyVersion,
      phase,
      phaseLabel: phaseLabel(phase),
      heightSource,
      clockTrust: view.trust,
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

/**
 * The governance rule that actually governs a proposal, or null. The rule is
 * only used when the cached policy is the SAME company and the SAME policy
 * version the proposal was made under — otherwise the clocks it produces
 * describe a different rulebook than the one the proposal answers to, while
 * looking authoritative.
 */
/**
 * The approval rounds that actually belong to a proposal. Rounds are
 * peer-writable and only keyed by proposal id in the cache, so one opened
 * under a different company or a different policy revision would otherwise be
 * rendered as this proposal's progress.
 */
export function sessionsFor(
  sessions: SigningSession[],
  proposal: TreasuryProposal,
): SigningSession[] {
  return sessions.filter(
    (s) =>
      s.companyId === proposal.companyId &&
      s.policyVersion === proposal.policyVersion &&
      s.proposalId === proposal.proposalId,
  );
}

/**
 * The board threshold to hold a proposal's approvals against, or null. Same
 * rule as the governance rule: a policy for another company — or another
 * revision of this one — describes a different board than the proposal
 * answers to.
 */
export function boardThresholdFor(
  proposal: TreasuryProposal,
  policy: CompanyTreasuryPolicy | null,
): number | null {
  if (!policy) return null;
  if (policy.companyId !== proposal.companyId) return null;
  if (policy.policyVersion !== proposal.policyVersion) return null;
  return policy.board.threshold;
}

export function governanceRuleFor(
  proposal: TreasuryProposal,
  policy: CompanyTreasuryPolicy | null,
): GovernanceKindRule | null {
  if (!policy) return null;
  if (policy.companyId !== proposal.companyId) return null;
  if (policy.policyVersion !== proposal.policyVersion) return null;
  return policy.governanceRules[proposal.kind] ?? null;
}

export interface PayloadView {
  /** Whether the room holds the bytes this proposal commits to. */
  present: boolean;
  /**
   * The one genuinely self-checked panel: the cache only returns payload
   * bytes whose hash it recomputed against the key they sit under.
   */
  trust: TrustTag;
  headline: string;
  detail: string;
}

/**
 * What a proposal would do. The payload is an opaque canonical blob with no
 * schema and no decoder yet, so the honest report is that the room either
 * holds the referenced details or does not — dumping raw hex at a player
 * teaches them nothing and reads as chain jargon the phone is meant to avoid.
 */
export function payloadView(present: boolean): PayloadView {
  return present
    ? {
        present: true,
        trust: trustTag('self-checked'),
        headline: 'Details held in this room',
        detail: 'The full details behind this proposal are stored here and match the fingerprint it commits to. They are not readable in the phone yet.',
      }
    : {
        present: false,
        trust: trustTag('absent'),
        headline: 'Details not held here',
        detail: 'This room does not have the details behind this proposal, so what it would do cannot be shown.',
      };
}

export interface CompanyScope {
  /** The company whose board and proposals the screen may show, or null. */
  companyId: string | null;
  /** True when a signed binding and the cached policy name different companies. */
  mismatch: boolean;
  warning: string | null;
}

/**
 * Which company this screen is entitled to present.
 *
 * The room binding is signed; the policy cache is freely replaceable. If a
 * peer writes a policy for another company, the screen would otherwise show
 * the binding's company as the funding source while rendering the OTHER
 * company's board and proposals under one "COMPANY" heading, with nothing
 * saying they disagree. When they disagree, show neither and say so.
 */
export function companyScope(
  binding: RoomTreasuryBinding | null,
  policy: CompanyTreasuryPolicy | null,
): CompanyScope {
  if (binding && policy && binding.companyId !== policy.companyId) {
    return {
      companyId: null,
      mismatch: true,
      warning: 'The company funding this room and the company details held here do not match, so neither is shown.',
    };
  }
  return {
    companyId: policy?.companyId ?? binding?.companyId ?? null,
    mismatch: false,
    warning: null,
  };
}

export interface ScopedProposals {
  /** Proposals governed by the company whose policy this screen shows. */
  shown: TreasuryProposal[];
  /** How many belong to some other company and were left out. */
  otherCompanies: number;
}

/**
 * The room map can hold proposals from any number of companies, but the
 * screen shows ONE company's board and policy above the list. Rows carry no
 * company of their own, so an unrelated proposal would read as governed by
 * that board. Scope to the shown company and report what was left out.
 */
export function scopeProposals(
  proposals: TreasuryProposal[],
  companyId: string | null,
): ScopedProposals {
  if (companyId === null) return { shown: proposals, otherCompanies: 0 };
  const shown = proposals.filter((p) => p.companyId === companyId);
  return { shown, otherCompanies: proposals.length - shown.length };
}

/** Largest allowance bound first — uses the no-parse mojo comparator. */
export function sortByAmountDesc<T>(items: T[], amountOf: (item: T) => MojoString): T[] {
  return [...items].sort((a, b) => compareMojoStrings(amountOf(b), amountOf(a)));
}
