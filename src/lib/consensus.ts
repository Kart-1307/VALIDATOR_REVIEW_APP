// --- Primary review vs. second-opinion consensus resolution ---
//
// Workflow (spec extension): one validator claims a question and performs
// the "primary review" (the 4-check validation checklist stored directly on
// the question). Up to MAX_CONSENSUS_REVIEWERS *other* validators can then
// each leave an independent "second opinion" (a ConsensusReview) without
// seeing or affecting the primary checklist. When the primary reviewer's
// verdict and the second opinions' majority verdict disagree, an admin
// reviews both sides and manually decides which one wins — exactly like a
// validator's manual status override, but scoped to resolving that
// disagreement, and always logged to the audit trail.
import { SATQuestion, ConsensusReview, MAX_CONSENSUS_REVIEWERS } from '../types';

export type ChecksVerdict = 'approved' | 'needs_revision' | 'pending';

// Same 3-outcome logic used for the primary checklist (spec §5): approved
// only if all four checks are explicitly "yes", needs_revision if any check
// is explicitly "no", otherwise still pending.
export function deriveChecksVerdict(checks: {
  formationOk?: boolean | null;
  answerOk?: boolean | null;
  categoryOk?: boolean | null;
  difficultyOk?: boolean | null;
}): ChecksVerdict {
  const vals = [checks.formationOk, checks.answerOk, checks.categoryOk, checks.difficultyOk];
  if (vals.every(v => v === true)) return 'approved';
  if (vals.some(v => v === false)) return 'needs_revision';
  return 'pending';
}

export interface ConsensusResolution {
  primaryVerdict: ChecksVerdict;
  // Second opinions from everyone EXCEPT the primary reviewer (claimedBy).
  secondOpinions: ConsensusReview[];
  secondOpinionApproved: number;
  secondOpinionNeedsRevision: number;
  // Majority verdict among decisive (non-pending) second opinions once at
  // least 2 have weighed in; null if there's no quorum yet or it's a tie.
  secondOpinionVerdict: ChecksVerdict | null;
  // True only when both sides have reached a decisive, opposing verdict —
  // this is what admins need to step in and resolve.
  hasDisagreement: boolean;
}

export function getConsensusResolution(q: SATQuestion): ConsensusResolution {
  const primaryVerdict = deriveChecksVerdict(q);
  const secondOpinions = (q.consensusReviews || []).filter(r => !q.claimedBy || r.validatorId !== q.claimedBy);

  const decisive = secondOpinions.map(deriveChecksVerdict).filter(v => v !== 'pending');
  const secondOpinionApproved = decisive.filter(v => v === 'approved').length;
  const secondOpinionNeedsRevision = decisive.filter(v => v === 'needs_revision').length;

  let secondOpinionVerdict: ChecksVerdict | null = null;
  if (decisive.length >= 2) {
    if (secondOpinionApproved > secondOpinionNeedsRevision) secondOpinionVerdict = 'approved';
    else if (secondOpinionNeedsRevision > secondOpinionApproved) secondOpinionVerdict = 'needs_revision';
  }

  const hasDisagreement =
    primaryVerdict !== 'pending' &&
    secondOpinionVerdict !== null &&
    primaryVerdict !== secondOpinionVerdict;

  return {
    primaryVerdict,
    secondOpinions,
    secondOpinionApproved,
    secondOpinionNeedsRevision,
    secondOpinionVerdict,
    hasDisagreement
  };
}

export { MAX_CONSENSUS_REVIEWERS };
