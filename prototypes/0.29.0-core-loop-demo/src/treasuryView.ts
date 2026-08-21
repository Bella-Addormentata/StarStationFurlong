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
// Text colours for treasury surfaces
// ---------------------------------------------------------------------------
//
// Named here rather than written inline because the alpha gold these replace
// was duplicated across the badge helper, the phone's `dim()` and two room
// terminal elements — so fixing the badge left the far more common paths at
// the same unreadable value. A caveat nobody can read is not a caveat.
//
// Both are opaque. Alpha over a dark surface is what produced the problem:
// 45% gold composites to about 2.6:1 and 50% to 2.9:1, well under the 4.5:1
// that these 8.5-9px strings need. Contrast below is measured against BOTH
// dark surfaces the treasury draws on — the phone screen (#04060F) and the
// room terminal panel (#040816).

/** Caveats, notes and qualifications. 5.5:1 phone / 5.4:1 terminal. */
export const TREASURY_MUTED = '#998356';

/** Section headers and row labels. 8.0:1 phone / 7.9:1 terminal. */
export const TREASURY_LABEL = '#b29a67';

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

/**
 * Recomputes a proposal's clocks rather than trusting the cached copy. Even a
 * clean recomputation only proves internal consistency: the registration it
 * derives from is an unverified cache entry until the node confirms the
 * registration on chain, which is why the trust tag never says "signed".
 */
export function windowsView(
  proposal: TreasuryProposal,
  registrationRaw: ProposalRegistration | null,
  rule: GovernanceKindRule | null,
  cachedRaw: ProposalWindows | null,
  /**
   * True when the room HOLDS an acceptance record that the reader could not
   * return — wrong shape, or filed under a key it does not claim. The reader
   * used to flatten that to null alongside a genuinely empty slot, so this
   * function's careful conflict reporting never saw it and the screen said
   * "no acceptance record is held" about a record sitting in the room.
   */
  registrationUnreadable = false,
  /** As above, for the cached-clocks slot. */
  cachedUnreadable = false,
): WindowsView {
  const registration =
    registrationRaw && registrationMatches(registrationRaw, proposal)
      ? registrationRaw
      : null;
  const cached =
    cachedRaw && cachedWindowsMatch(cachedRaw, proposal) ? cachedRaw : null;
  // A record that was held but rejected is not the same as no record, and
  // saying "none is held" would quietly turn a conflicting peer write into
  // an absence.
  const registrationConflicts =
    (registrationRaw !== null && registration === null) || registrationUnreadable;
  const cachedConflicts = (cachedRaw !== null && cached === null) || cachedUnreadable;
  const missingRegistrationNote = registrationUnreadable && registrationRaw === null
    ? 'an acceptance record is held here but this device cannot make sense of it'
    : registrationConflicts
      ? 'an acceptance record is held here but it describes a different proposal'
      : 'no acceptance record is held here';
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
        // Both inputs WERE held — they are just unusable. NO DATA would put
        // "nothing cached yet" in the tooltip beside a note saying otherwise.
        trust: trustTag('unverified'),
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
        : `Copied from another player: ${missingRegistrationNote}, so these clocks could not be worked out independently.`,
    };
  }
  return {
    windows: null,
    source: 'none',
    // Anything HELD is data, however unusable — a matching registration we
    // could not pair with a policy included. Only a genuinely empty slot
    // earns NO DATA, whose badge says nothing is cached.
    trust: trustTag(
      registration || registrationConflicts || cachedConflicts ? 'unverified' : 'absent',
    ),
    // A rejected cached clock record is data too, and it is what raised the
    // badge above NO DATA — so it belongs in the note. Left out, the last
    // branch below would say "no acceptance record is held" while a record
    // sits in the room, which is the absence-as-fact mistake again, and the
    // badge and the sentence beside it would disagree.
    note:
      (registration
        ? 'The company policy is missing here, so this proposal’s clocks cannot be worked out.'
        : registrationUnreadable && registrationRaw === null
          ? 'An acceptance record is held here, but this device cannot make sense of it, so this proposal’s clocks cannot be worked out.'
          : registrationConflicts
            ? 'The acceptance record held here describes a different proposal, so this one’s clocks cannot be worked out.'
            : 'No acceptance record for this proposal is held in this room yet.')
      + (cachedConflicts
        ? ' A copied set of clocks is held here as well, but it belongs to a different proposal or policy version.'
        : ''),
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
    // "one per key", not "one per voter": the slot is keyed by the signing
    // key, and one person can hold several, so voter-level wording would
    // imply a deduplication that does not happen here.
    note: 'Votes held in this room, one per signing key — not a count, and not weighted by shares.',
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
   * Which round `collected` describes, so a caller can qualify THAT round.
   * Without it, a caveat about any round the scan touched — an expired or
   * foreign one — landed on the count for a round that was complete.
   */
  selectedSessionId: string | null;
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
  /**
   * False when the rounds handed in are only part of what the room holds —
   * the scan was cut short, a page was shown, or entries were rejected or
   * refused on size.
   *
   * Without it the zero case asserted "No approval round open in this room"
   * while the warnings printed directly beneath it said a round might be
   * unread or on another page. The panel contradicted itself, and the
   * confident half was the wrong half.
   */
  complete = true,
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
  // Which rounds count as open is decided against a height nobody here
  // checked, and a peer reporting a very high or low one could hide live
  // rounds or revive ended ones — so the basis is named, exactly as it is for
  // proposal clocks and funding expiry.
  const staleness =
    currentHeight === null
      ? sessions.length > 0
        ? ' Whether these rounds are still open cannot be judged without a chain height.'
        : ''
      : expired > 0
        ? ` ${expired} round${expired === 1 ? '' : 's'} already past its end height ${expired === 1 ? 'is' : 'are'} left out, judged against a height another player reported and not checked here.`
        : ' Which rounds count as still open is judged against a height another player reported, not checked here.';
  return {
    sessions: live.length,
    collected: best ? best.collectedSigs.length : 0,
    // Which round the count above describes, so a caller can qualify THAT
    // round rather than every round the scan happened to touch.
    selectedSessionId: best ? best.sessionId : null,
    required,
    requiredFromPolicy: policyThreshold !== null,
    trust: trustTag('unverified'),
    note:
      (live.length === 0
        ? complete
          ? 'No approval round open in this room.'
          : 'No approval round is open among the records read for this screen — that is not the same as there being none.'
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
  /** False when no lookup ran, so "no claim" is not evidence of absence. */
  readable: boolean;
  /** The peer claim is a shape-only cache like any other panel's data. */
  trust: TrustTag;
}

/**
 * Offline/read-only state is each node's own verdict (amendment §6/§15.3), and
 * the shared sync key is peer-writable, so it is rendered as a claim rather
 * than a status. With no local chain view the local verdict is 'unavailable':
 * the UI is read-only and says why.
 */
export function syncView(
  peer: ChainSyncStatus | null,
  /** False when no lookup was attempted (no network pinned, or no room). */
  readable = true,
  /**
   * True when an entry IS held under the sync key but could not be read.
   * Without it, "a player wrote something unreadable here" and "nobody has
   * written anything" both came out as NO DATA.
   */
  held = false,
): SyncView {
  if (!readable) {
    return {
      localState: 'unavailable',
      localNote: 'This device is not verifying the chain yet, so nothing here is final and no spending is possible from the phone.',
      peerClaim: null,
      peerHeight: null,
      readable: false,
      // Not "nothing cached": nothing was looked up, which is a different
      // statement — the same distinction the funding panel makes.
      trust: {
        ...trustTag('absent'),
        detail: 'No lookup was possible, so nothing is known either way.',
      },
    };
  }
  return {
    localState: 'unavailable',
    localNote: 'This device is not verifying the chain yet, so nothing here is final and no spending is possible from the phone.',
    peerClaim: peer ? peer.state : null,
    peerHeight: peer && typeof peer.verifiedHeight === 'number' ? peer.verifiedHeight : null,
    readable: true,
    // A held-but-unreadable entry is somebody having written here, which is
    // not "nobody has said anything". Same distinction the funding and policy
    // panels make; the sync slot had it collapsed.
    trust: peer
      ? trustTag('unverified')
      : held
        ? {
            ...trustTag('unverified'),
            label: 'UNREAD',
            detail: 'A player wrote a chain-view claim here, but this device could not make sense of it.',
          }
        : trustTag('absent'),
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

export interface ShareClassListView {
  items: ShareClassView[];
  /** True when the policy declares more classes than were returned. */
  truncated: boolean;
  /** How many were left out — named on screen, never silently dropped. */
  hidden: number;
}

/**
 * §11.4: classes are readable, creation stays out of the UI.
 *
 * Bounded, and honest about it. The policy key is peer-writable, shape-only
 * and plain-replace, and nothing in the record schema limits how many classes
 * it declares — so an unbounded map here became an unbounded row count in the
 * phone's COMPANY panel, rebuilt into innerHTML on every repaint a peer chose
 * to trigger, pushing BALANCES and PROPOSALS off the screen. The record-size
 * budget in treasuryDoc refuses the extreme cases but still admits a few
 * hundred classes, which is a few hundred rows.
 *
 * The proposal list beside this one has capped and disclosed its page since
 * PR C; this is the same contract, in the same unit-tested layer, so the cap
 * cannot be forgotten by a caller building markup.
 */
export function shareClassViews(
  policy: CompanyTreasuryPolicy,
  max = 24,
): ShareClassListView {
  const all = policy.shareClasses;
  const shown = max >= 0 ? all.slice(0, max) : [];
  return {
    items: shown.map((c) => ({
      id: c.id,
      votesPerWholeShare: c.votesPerWholeShare,
      grantsRoomAccess: c.grantsRoomAccess,
      transferable: c.transferable,
    })),
    truncated: shown.length < all.length,
    hidden: all.length - shown.length,
  };
}

/**
 * Whether this device can read funding records at all, and if not, why.
 *
 *  'readable'    a network is pinned and a room document is attached.
 *  'no-network'  no company network is configured for this build — a local
 *                setup fact, nothing to do with the room or the connection.
 *  'no-room'     no room document to read from.
 *  'too-large'   a binding IS held, and this device refused to read it on
 *                size alone. A local decision, so it is reported as a refusal
 *                rather than as no record.
 *  'unreadable'  a binding IS held and cannot be made sense of — wrong shape,
 *                wrong network, or a broken signature. Still a held record,
 *                so still not the same as there being none.
 */
export type FundingReadAccess =
  | 'readable'
  | 'no-network'
  | 'no-room'
  | 'too-large'
  | 'unreadable';

export interface RoomFundingView {
  bound: boolean;
  /**
   * Whether the record's own end height has been reached. 'unknown' — no
   * height was available to judge by — is deliberately a state of its own and
   * not folded into 'not-passed': a boolean lived here once and collapsed the
   * two, which rendered an ended record as current funding.
   *
   * 'none' means only that no end height is in play, so it is also what the
   * two recordless branches report — read it together with `bound`, never as
   * a claim that funding is open-ended.
   */
  expiryStatus: 'none' | 'unknown' | 'passed' | 'not-passed';
  /**
   * Set whenever the record names an end height. The signature covers that
   * height but never the claim about where the chain has got to, so every
   * reading of it is qualified apart from the record's own trust tag.
   */
  expiryNote: string | null;
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
   * Why a read could or could not run. A read that cannot run is NOT evidence
   * that no record exists — and WHICH obstacle stopped it is a fact of its own
   * that the player is entitled to. Rolled into one boolean, an unconfigured
   * build got blamed on a failing room connection, which is both wrong and
   * unactionable: nothing about the room is broken.
   */
  access: FundingReadAccess = 'readable',
): RoomFundingView {
  const readOnlyNote = 'Read-only: this device does not check the chain, so none of this is confirmed.';
  const unavailable = [
    'Covered systems and remaining budgets',
    'Any pending request to bind or unbind',
  ];
  if (access !== 'readable') {
    return {
      bound: false,
      expiryStatus: 'none',
      expiryNote: null,
      companyId: null,
      treasuryId: null,
      profileId: null,
      policyVersion: null,
      boundAtHeight: null,
      expiresAfterHeight: null,
      // The badge has to agree with the headline beside it. Two of these
      // states mean a record IS held — this device just would not or could
      // not read it — so NO DATA / "nothing cached yet" would flatly
      // contradict a headline that says a record is here.
      trust:
        access === 'too-large' || access === 'unreadable'
          ? {
              ...trustTag('unverified'),
              label: 'UNREAD',
              detail:
                access === 'too-large'
                  ? 'A record is held here, but this device would not read it: it is larger than this device is willing to process.'
                  : 'A record is held here, but this device could not make sense of it.',
            }
          : {
              ...trustTag('absent'),
              detail: 'No lookup was possible, so nothing is known either way.',
            },
      headline:
        access === 'too-large'
          ? 'Funding record too large to read'
          : access === 'unreadable'
            ? 'Funding record cannot be read'
            : 'Funding records unavailable',
      detail:
        access === 'no-network'
          ? 'No company network is set up for this build, so this device cannot read company records at all. Nothing here is a fault in this room.'
          : access === 'too-large'
            ? 'This room is holding a company funding record, but it is too large for this device to read. That is this device’s limit, not a fault in the record — and it is not the same as there being no record.'
            : access === 'unreadable'
              ? 'This room is holding a company funding record, but this device cannot make sense of it — wrong shape, wrong network, or a broken signature. Something is here; what it says is unknown.'
              : 'This device is not attached to a room’s records, so it cannot say how this room is funded either way.',
      readOnlyNote,
      unavailable,
    };
  }
  if (!binding) {
    return {
      bound: false,
      expiryStatus: 'none',
      expiryNote: null,
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
  // Three outcomes, not two. "Still live" and "no trustworthy height to
  // decide with" are different statements, and collapsing them into a false
  // `lapsed` made an ended record render as current funding — including when
  // a peer supplies a stale low height. The signature covers the record and
  // the end height it names, never the claim about where the chain has got
  // to, so BOTH the passed and not-passed readings are qualified.
  // A height BELOW the record's own boundAtHeight contradicts the record: the
  // binding says it started at a block the reported height has not reached.
  // Two peer-written numbers disagreeing is not evidence the funding is
  // current, so it is 'unknown' — the same treatment proposalPhase gives a
  // height that precedes acceptance.
  const heightIsConsistent =
    currentHeight !== null && currentHeight >= binding.boundAtHeight;
  const expiryStatus: 'none' | 'unknown' | 'passed' | 'not-passed' =
    expires === null
      ? 'none'
      : currentHeight === null || !heightIsConsistent
        ? 'unknown'
        : currentHeight >= expires
          ? 'passed'
          : 'not-passed';
  const expiryNote =
    expiryStatus === 'unknown'
      ? // Two ways to be unknown, and the terminal prints the reported height
        // next to this line — so "no chain height available" beside an actual
        // number was a flat contradiction on screen.
        currentHeight === null
        ? 'This record names an end height, but with no chain height available this device cannot say whether it has passed.'
        : 'This record names an end height, but the height another player reported is earlier than the block this record says it started at — the two disagree, so this device cannot say whether it has passed.'
      : expiryStatus === 'passed'
        ? 'The end height appears to have passed, judged against a height another player reported — not covered by the signature and not checked here.'
        : expiryStatus === 'not-passed'
          ? 'It appears not to have ended yet, judged against a height another player reported — not covered by the signature and not checked here.'
          : null;
  return {
    bound: true,
    expiryStatus,
    expiryNote,
    companyId: binding.companyId,
    treasuryId: binding.treasuryLauncherId,
    profileId: binding.profileId,
    policyVersion: binding.policyVersion,
    boundAtHeight: binding.boundAtHeight,
    expiresAfterHeight: expires,
    trust: trustTag('signed'),
    // Always "record", never "Company funding" on its own — including when no
    // end height is named. A signature shows who wrote the statement; it does
    // not show they were entitled to write it, that the chain ever confirmed
    // it, or that it has not since been unbound. An open-ended record is
    // therefore no more evidence of live funding than an expiring one, and a
    // headline saying otherwise would be exactly the invented certainty the
    // rest of this module refuses.
    headline:
      expiryStatus === 'passed'
        ? 'Company funding record · may have ended'
        : 'Company funding record',
    detail:
      expiryStatus === 'passed'
        ? 'This record’s own end height appears to have passed, so it may no longer fund the room. Funding a room grants nobody edit rights here — those stay separate.'
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
  /**
   * WHERE those clocks came from. The trust tag alone cannot say: both the
   * recomputed and the copied path are 'unverified' — correctly, since both
   * rest on peer-written inputs — so without this the list rendered a window
   * copied wholesale from another player identically to one worked out here
   * from a matching acceptance record. Same trust, materially different
   * provenance, and only the detail screen was saying so.
   */
  clockSource: WindowsView['source'];
  /** Short provenance word for the row, or null when there are no clocks. */
  clockSourceLabel: string | null;
}

const CLOCK_SOURCE_LABELS: Record<WindowsView['source'], string | null> = {
  recomputed: 'WORKED OUT HERE',
  cached: 'COPIED FROM A PLAYER',
  none: null,
};

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
      clockSource: view.source,
      clockSourceLabel: CLOCK_SOURCE_LABELS[view.source],
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
 * The vote-confirmation records that actually belong to a proposal. Like
 * approval rounds, these are keyed by proposal id alone, so a peer can file a
 * self-consistent record carrying that id under a different company and have
 * it counted among this proposal's.
 */
export function checkpointsFor(
  checkpoints: TreasuryCheckpoint[],
  proposal: TreasuryProposal,
): TreasuryCheckpoint[] {
  return checkpoints.filter(
    (c) =>
      c.companyId === proposal.companyId && c.proposalId === proposal.proposalId,
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

/**
 * The governance rule that actually governs a proposal, or null. The rule is
 * only used when the cached policy is the SAME company and the SAME policy
 * version the proposal was made under — otherwise the clocks it produces
 * describe a different rulebook than the one the proposal answers to, while
 * looking authoritative.
 */
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
export function payloadView(
  /**
   * Four states, not a boolean. 'too-large' and 'unreadable' both mean the
   * room HOLDS the details — this device just would not or could not read
   * them — so reporting either as "not held here" would deny what is there.
   */
  status: 'ok' | 'absent' | 'unreadable' | 'too-large',
): PayloadView {
  if (status === 'ok') {
    return {
      present: true,
      trust: trustTag('self-checked'),
      headline: 'Details held in this room',
      detail: 'The full details behind this proposal are stored here and match the fingerprint it commits to. They are not readable in the phone yet.',
    };
  }
  if (status === 'absent') {
    return {
      present: false,
      trust: trustTag('absent'),
      headline: 'Details not held here',
      detail: 'This room does not have the details behind this proposal, so what it would do cannot be shown.',
    };
  }
  return {
    present: false,
    // Held, so not NO DATA — the badge has to agree with the headline.
    trust: {
      ...trustTag('unverified'),
      label: 'UNREAD',
      detail:
        status === 'too-large'
          ? 'The details are held here, but this device would not read them: they are larger than it is willing to process.'
          : 'The details are held here, but they do not match the fingerprint this proposal commits to.',
    },
    headline:
      status === 'too-large' ? 'Details too large to read' : 'Details do not match',
    detail:
      status === 'too-large'
        ? 'This room is holding the details behind this proposal, but they are larger than this device will read. That is this device’s limit, not a fault in the record.'
        : 'This room is holding something under this proposal’s details, but it does not match the fingerprint the proposal commits to — so it is not shown.',
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
  /**
   * True when a binding IS held but could not be used — malformed, off-network,
   * or refused on size.
   *
   * Without this the plain reader's null was indistinguishable from "no
   * binding at all", and the fallback below then let the freely-writable
   * policy name the company on its own. That hands a peer a way to neutralise
   * the SIGNED anchor and have their own company's board, fingerprint and
   * proposal list rendered as this room's: write junk over the binding slot,
   * then write whatever policy you like.
   */
  bindingHeldButUnusable = false,
): CompanyScope {
  if (bindingHeldButUnusable) {
    return {
      companyId: null,
      mismatch: true,
      warning: 'A company funding record is held in this room but cannot be read, so the company details and proposal list are not shown — there is no signed record here to check them against.',
    };
  }
  // Company AND treasury: both records name a treasury too, so a policy for
  // the right company but a different treasury would otherwise have that
  // treasury's board, fee ceiling and fingerprint rendered as if the signed
  // funding record agreed with them.
  if (
    binding &&
    policy &&
    (binding.companyId !== policy.companyId ||
      binding.treasuryLauncherId !== policy.treasuryLauncherId)
  ) {
    return {
      companyId: null,
      mismatch: true,
      // Precise about what is actually withheld: the signed funding record
      // above stays on screen with its own company, and it is the cached
      // company details and proposal list that are held back.
      warning: 'The company details held in this room do not match the funding record above, so they and the proposal list are not shown.',
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
  /**
   * True when no company could be identified at all, so nothing is listed:
   * the rows carry no company of their own, and a mixed list would be
   * indistinguishable.
   */
  scopeUnknown: boolean;
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
  if (companyId === null) {
    // Withhold rather than mix: this is a one-company screen and the rows
    // show no company, so an unscoped list would present several companies'
    // proposals as one board's business. The count is still reported.
    return { shown: [], otherCompanies: proposals.length, scopeUnknown: true };
  }
  const shown = proposals.filter((p) => p.companyId === companyId);
  return {
    shown,
    otherCompanies: proposals.length - shown.length,
    scopeUnknown: false,
  };
}

/**
 * Two key spaces behind one pair of buttons.
 *
 * The detail screen pages votes and vote records together, but they are
 * separate prefixes with separate lengths: one can run out while the other
 * still has pages. Advancing only the stack that moved leaves the two stacks
 * at different heights, and since PREVIOUS pops both, they stop describing the
 * same navigation steps — with two vote pages and four checkpoint pages, the
 * third NEXT advances only checkpoints, and one PREVIOUS then drops votes two
 * steps to page 1 while checkpoints go back one.
 *
 * So every step appends to BOTH, an exhausted scan repeating its current
 * cursor. Equal heights are the invariant; a repeated cursor is what "this
 * side had nowhere further to go" looks like in the history.
 */
export interface CursorPair {
  readonly a: readonly (string | null)[];
  readonly b: readonly (string | null)[];
}

export function advanceCursorPair(
  pair: CursorPair,
  aNext: string | null,
  bNext: string | null,
): CursorPair {
  // Neither side has a further page, so this is not a step and nothing is
  // recorded. Pushing here would grow the history on a button that changed
  // nothing, and the matching PREVIOUS would then appear to do nothing.
  if (aNext === null && bNext === null) return pair;
  return {
    a: [...pair.a, aNext ?? pair.a[pair.a.length - 1]],
    b: [...pair.b, bNext ?? pair.b[pair.b.length - 1]],
  };
}

export function retreatCursorPair(pair: CursorPair): CursorPair {
  if (pair.a.length <= 1 && pair.b.length <= 1) return pair;
  return { a: pair.a.slice(0, -1), b: pair.b.slice(0, -1) };
}

/** Largest allowance bound first — uses the no-parse mojo comparator. */
export function sortByAmountDesc<T>(items: T[], amountOf: (item: T) => MojoString): T[] {
  return [...items].sort((a, b) => compareMojoStrings(amountOf(b), amountOf(a)));
}
