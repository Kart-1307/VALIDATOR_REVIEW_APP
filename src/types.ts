// --- Spec §6: threaded, timestamped, attributed comments per question ---
export interface QuestionComment {
  id: string;
  text: string;
  timestamp: string; // ISO timestamp
  author: string; // validator name/id who left the comment
}

// Max number of distinct "second opinion" validators (spec §7 extension:
// multi-validator support). One validator claims a question and performs the
// primary review (the 4-check checklist stored directly on the question);
// up to this many OTHER validators can each leave an independent second
// opinion. If the primary reviewer and the second-opinion majority disagree,
// an admin resolves it (see src/lib/consensus.ts).
export const MAX_CONSENSUS_REVIEWERS = 3;

// --- Spec §7: independent second-reviewer snapshot for consensus/inter-rater checks ---
export interface ConsensusReview {
  validatorId: string;
  validatorName: string;
  formationOk: boolean | null;
  answerOk: boolean | null;
  categoryOk: boolean | null;
  difficultyOk: boolean | null;
  timestamp: string;
}

export interface SATQuestion {
  id: string;
  category: string;
  subSkill?: string | null;
  // --- Question type (spec §4: "MCQ, grid-in, etc.") ---
  questionType?: 'mcq' | 'grid_in' | string;
  passage: string | null;
  // --- Stimulus: separate from `passage` — holds equations, data tables, graph
  // descriptions, or other supplementary material (esp. common on Math items)
  // that must be preserved verbatim and not merged into/confused with passage. ---
  stimulus?: string | null;
  // --- Supporting graphic (spec §4: "Any supporting passage/graphic if applicable") ---
  imageUrl?: string | null;
  question: string;
  choices: {
    A: string;
    B: string;
    C: string;
    D: string;
  };
  correct_answer: string;
  explanation: string;
  module?: string;
  Section?: string; // Note: Handle both uppercase 'Section' and lowercase 'section'
  section?: string;
  difficulty: 'easy' | 'medium' | 'hard' | string;
  reviewStatus?: 'pending' | 'approved' | 'rejected' | 'needs_revision';
  createdAt?: string;

  // --- Validator context (from the pipeline's own verdict, set during generation) ---
  validatorStatus?: 'approved' | 'escalated' | 'rejected' | string;
  validatorFeedback?: string;
  similarity_score?: number;
  similar_question_id?: string;

  // --- Reviewer feedback loop (spec §6: multiple, threaded, timestamped,
  // attributed comments per question, e.g. why it was rejected, or a
  // re-review note after a fix). Newest is appended, never overwritten. ---
  comments?: QuestionComment[];
  // Legacy single free-text note field, kept for backward compatibility with
  // older exported/imported JSON files. New comments always go into `comments`.
  reviewerNote?: string;

  // --- Validation Actions checklist (spec §5) ---
  // Four independent Yes/No checks a human validator confirms per question.
  // `null`/undefined = not yet checked, so the overall status can stay 'pending'.
  formationOk?: boolean | null;
  answerOk?: boolean | null;
  categoryOk?: boolean | null;
  // If categoryOk is false, the validator can reassign to the correct category here.
  categoryOverride?: string | null;
  difficultyOk?: boolean | null;
  // If difficultyOk is false, the validator can reassign the correct difficulty here.
  difficultyOverride?: 'easy' | 'medium' | 'hard' | null;

  // Manual override of the auto-derived overall status, with required justification.
  statusOverride?: 'approved' | 'rejected' | 'needs_revision' | null;
  statusOverrideJustification?: string;

  // --- Claim/lock (spec §3, §7): prevents two validators from reviewing the
  // same question at once. `claimedBy` is a profile id; null = unclaimed. ---
  claimedBy?: string | null;
  claimedByName?: string | null;
  claimedAt?: string | null;

  // --- Admin-assigned queue (spec §3): distinct from self-serve claim above ---
  assignedTo?: string | null;
  assignedToName?: string | null;

  // --- Second-reviewer / consensus mode (spec §7) ---
  requiresSecondReview?: boolean;
  consensusReviews?: ConsensusReview[];

  // Generator batch/run id (spec §3 filter, §12 data model)
  generatorRunId?: string;
}

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'needs_revision';

export interface FilterState {
  search: string;
  section: string;
  category: string;
  difficulty: string;
  status: 'all' | 'pending' | 'approved' | 'rejected' | 'needs_revision';
  generatorRunId?: string;
  assignedOrClaimedBy?: string; // profile id — matches either assignedTo or claimedBy
  dateFrom?: string; // yyyy-mm-dd
  dateTo?: string; // yyyy-mm-dd
}

// --- Sort control (spec §3: "Filter/sort by ... date generated ...") ---
export type SortField = 'dateGenerated' | 'difficulty' | 'category' | 'id';
export type SortDirection = 'asc' | 'desc';

export interface StatsSummary {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  needsRevision: number;
  bySection: Record<string, number>;
  byDifficulty: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface ValidatorInvite {
  email: string;
  name: string;
  role: 'validator' | 'admin' | 'auditor';
  invited_at: string;
}