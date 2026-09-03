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
  // Optional: grid-in questions (free numeric response) have no A/B/C/D
  // options, so this is null/undefined for them in the database. Marking
  // it required here was inaccurate and let several call sites do
  // question.choices[...] / Object.entries(question.choices) without a
  // guard, which crashed the whole app (no error boundary) the moment a
  // grid-in question was rendered/edited/analyzed.
  choices?: {
    A: string;
    B: string;
    C: string;
    D: string;
  } | null;
  correct_answer: string;
  explanation: string;
  module?: string;
  Section?: string; // Note: Handle both uppercase 'Section' and lowercase 'section'
  section?: string;
  difficulty: 'easy' | 'medium' | 'hard' | string;
  reviewStatus?: 'pending' | 'approved' | 'rejected' | 'needs_revision';
  createdAt?: string;
  // Last-modified timestamp (DB `updated_at`, trigger-maintained). Used as a
  // best-effort "approved on" date for the datewise approved-questions
  // export — there's no dedicated approved_at column yet, so this is the
  // closest signal we have (see mappers.ts: toLocalDateKey).
  updatedAt?: string;

  // --- New Batch tab only: which upload this question was introduced by.
  // batchUploadedAt is the effectively-unique key (ISO timestamp of the
  // merge event); batchLabel is the admin-facing display name (falls back
  // to a formatted date if left blank on upload). Never set/read on the
  // main Curator `questions` table — see mappers usage in
  // NewBatchWorkspace.tsx. ---
  batchLabel?: string | null;
  batchUploadedAt?: string | null;

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

// --- Per-question revert history (question_snapshots table): a pre-action
// copy of one question, taken right before a state-changing action runs.
// Admin can restore a question to any of these exact prior states from the
// History drawer. See App.tsx: snapshotQuestionBeforeChange /
// handleRestoreQuestionSnapshot, and QuestionHistoryDrawer.tsx. ---
export interface QuestionSnapshot {
  id: string;
  question_id: string;
  created_at: string;
  action_type: string;
  performed_by: string | null;
  performed_by_name: string | null;
  snapshot: SATQuestion;
  restored: boolean;
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