import { SATQuestion } from '../types';

// Row shape as stored in the public.questions table (snake_case, per SQL convention).
export interface QuestionRow {
  id: string;
  category: string;
  sub_skill: string | null;
  question_type: string | null;
  image_url?: string | null;
  passage: string | null;
  stimulus?: string | null;
  question: string;
  choices: { A: string; B: string; C: string; D: string };
  correct_answer: string;
  explanation: string;
  module: string | null;
  section: string | null;
  difficulty: string;
  generator_run_id: string | null;
  review_status: string;
  validator_status: string | null;
  validator_feedback: string | null;
  similarity_score: number | null;
  similar_question_id: string | null;
  formation_ok: boolean | null;
  answer_ok: boolean | null;
  category_ok: boolean | null;
  category_override: string | null;
  difficulty_ok: boolean | null;
  difficulty_override: string | null;
  status_override: string | null;
  status_override_justification: string | null;
  comments: SATQuestion['comments'];
  claimed_by: string | null;
  claimed_by_name: string | null;
  claimed_at: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  requires_second_review: boolean;
  consensus_reviews: SATQuestion['consensusReviews'];
  created_at: string;
  updated_at: string;
}

// Local (browser timezone) yyyy-mm-dd for a timestamp. Used to bucket a
// question's last-modified time into a calendar day for the datewise
// approved-questions export (see App.tsx: downloadApprovedRangeBatch).
export function toLocalDateKey(isoTimestamp: string | null | undefined): string | null {
  if (!isoTimestamp) return null;
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Shared approval-date filter used by BOTH the main Curator tab
// (App.tsx: downloadApprovedRangeBatch) and the New Batch workspace
// (NewBatchWorkspace.tsx: downloadApprovedRangeBatch), so brushing up a
// timezone/edge-case fix here propagates to both exports.
//
// NOTE (repository limitation): there is no dedicated `approved_at` column in
// the schema, so `updated_at` is used as the best-effort "when was this
// approved" proxy (the `questions_set_updated_at` trigger bumps it whenever a
// question row changes, which includes the approve action). `fromKey`/`toKey`
// are inclusive yyyy-mm-dd local-date keys. A question approved around
// midnight is bucketed by the browser's local timezone via toLocalDateKey,
// i.e. the same tz the app itself runs in.
export function isApprovedInDateRange(
  q: { reviewStatus?: string | null; updatedAt?: string | null; createdAt?: string | null },
  fromKey: string,
  toKey: string
): boolean {
  if (!q || q.reviewStatus !== 'approved') return false;
  if (!fromKey || !toKey) return false;
  const [rangeStart, rangeEnd] = fromKey <= toKey ? [fromKey, toKey] : [toKey, fromKey];
  const dateKey = toLocalDateKey(q.updatedAt || q.createdAt);
  return !!dateKey && dateKey >= rangeStart && dateKey <= rangeEnd;
}

// Clean text for production JSON exports. Keep meaningful SAT content intact while
// removing BOM/zero-width characters and normalizing line endings/Unicode form so
// exported files do not contain hidden encoding artifacts. JSON.stringify emits
// normal Unicode characters directly (it does not turn them into \uXXXX escapes).
function cleanExportText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;

  const cleaned = value
    .normalize('NFC')
    .replace(/\uFEFF/g, '')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  return cleaned || null;
}

// Production/student-app schema keeps the actual question prompt in `question`
// and puts any supporting passage/stimulus in `passage`. Stimulus is intentionally
// not exported as a separate field. This also handles future generated questions
// where stimulus is absent, passage is absent, or both are absent.
export function buildProductionPassage(q: {
  passage?: string | null;
  stimulus?: string | null;
}): string | null {
  const parts = [cleanExportText(q.passage), cleanExportText(q.stimulus)]
    .filter((part): part is string => !!part);

  // Avoid repeating identical passage/stimulus content.
  const uniqueParts = parts.filter((part, index) => parts.indexOf(part) === index);
  return uniqueParts.length ? uniqueParts.join('\n\n') : null;
}

// --- Production question bank export (README §1 "Vetted Production Test
// Bank", spec §10/§12/§13). This is the schema the MySAT AI Coach production
// engine consumes and the repo's source of truth for the `production_bank`
// export — it used to be inlined in App.tsx's downloadProductionBank and is
// now shared so the New Batch workspace can produce the identical format.
// Each approved question becomes ONE complete record; any supporting
// passage/stimulus live as fields on that same record (never separate rows).
export function buildProductionBankRecord(q: SATQuestion) {
  return {
    id: q.id,
    stem: q.question,
    question_type: q.questionType || 'mcq',
    choices: q.choices,
    correct_answer: q.correct_answer,
    explanation: q.explanation,
    category: q.category,
    sub_skill: q.subSkill || null,
    difficulty: q.difficulty,
    passage: q.passage || null,
    stimulus: q.stimulus || null,
    image_url: q.imageUrl || null,
    generator_run_id: q.generatorRunId || null,
    status: 'validated',
    validated_at: new Date().toISOString(),
    created_at: q.createdAt || null
  };
}

// --- Raw export ("new batch schema"). Reflects the exact column set of the
// questions_batch2 table (a structural clone of public.questions, see
// migration_new_batch_workspace.sql §1) — the shared source of truth for the
// full internal record. Every question is exported as ONE complete object:
// the question content, answer/options, metadata, validator details and
// validation results, stimulus (embedded as a field, not a separate record),
// IDs and references. batch_label / batch_uploaded_at are New-Batch-only
// columns and fall back to null for main-`questions` rows.
export function buildRawExportRecord(q: SATQuestion) {
  return {
    id: q.id,
    category: q.category,
    sub_skill: q.subSkill ?? null,
    question_type: q.questionType || 'mcq',
    image_url: q.imageUrl ?? null,
    passage: q.passage ?? null,
    stimulus: q.stimulus ?? null,
    question: q.question,
    choices: q.choices ?? null,
    correct_answer: q.correct_answer,
    explanation: q.explanation,
    module: q.module ?? null,
    section: q.Section || q.section || null,
    difficulty: q.difficulty,
    generator_run_id: q.generatorRunId ?? null,
    review_status: q.reviewStatus || 'pending',
    validator_status: q.validatorStatus ?? null,
    validator_feedback: q.validatorFeedback ?? null,
    similarity_score: typeof q.similarity_score === 'number' ? q.similarity_score : null,
    similar_question_id: q.similar_question_id ?? null,
    formation_ok: q.formationOk ?? null,
    answer_ok: q.answerOk ?? null,
    category_ok: q.categoryOk ?? null,
    category_override: q.categoryOverride ?? null,
    difficulty_ok: q.difficultyOk ?? null,
    difficulty_override: q.difficultyOverride ?? null,
    status_override: q.statusOverride ?? null,
    status_override_justification: q.statusOverrideJustification ?? null,
    comments: q.comments ?? [],
    claimed_by: q.claimedBy ?? null,
    claimed_by_name: q.claimedByName ?? null,
    claimed_at: q.claimedAt ?? null,
    assigned_to: q.assignedTo ?? null,
    assigned_to_name: q.assignedToName ?? null,
    requires_second_review: !!q.requiresSecondReview,
    consensus_reviews: q.consensusReviews ?? [],
    created_at: q.createdAt ?? null,
    updated_at: q.updatedAt ?? null,
    batch_label: q.batchLabel ?? null,
    batch_uploaded_at: q.batchUploadedAt ?? null
  };
}

export function buildProductionExportRecord(q: SATQuestion) {
  return {
    id: q.id,
    Section: q.Section || q.section || null,
    category: q.category,
    question: cleanExportText(q.question) || '',
    passage: buildProductionPassage(q),
    choices: q.choices,
    correct_answer: q.correct_answer,
    explanation: cleanExportText(q.explanation) || '',
    difficulty: q.difficulty
  };
}

export function rowToQuestion(row: QuestionRow): SATQuestion {
  return {
    id: row.id,
    category: row.category,
    subSkill: row.sub_skill || undefined,
    questionType: row.question_type || 'mcq',
    imageUrl: row.image_url || null,
    passage: row.passage,
    stimulus: row.stimulus ?? null,
    question: row.question,
    choices: row.choices,
    correct_answer: row.correct_answer,
    explanation: row.explanation,
    module: row.module || undefined,
    Section: row.section || undefined,
    section: row.section || undefined,
    difficulty: row.difficulty as SATQuestion['difficulty'],
    reviewStatus: row.review_status as SATQuestion['reviewStatus'],
    createdAt: row.created_at,
    // Not written back on upsert (questionToRow deliberately omits it — the
    // `questions_set_updated_at` trigger in schema.sql owns this column).
    // Used as the best-effort "when was this last touched" signal for the
    // datewise approved-questions export, since there is no dedicated
    // approved_at column.
    updatedAt: row.updated_at,
    validatorStatus: row.validator_status || undefined,
    validatorFeedback: row.validator_feedback || undefined,
    similarity_score: row.similarity_score ?? undefined,
    similar_question_id: row.similar_question_id || undefined,
    comments: row.comments || [],
    formationOk: row.formation_ok,
    answerOk: row.answer_ok,
    categoryOk: row.category_ok,
    categoryOverride: row.category_override,
    difficultyOk: row.difficulty_ok,
    difficultyOverride: row.difficulty_override as SATQuestion['difficultyOverride'],
    statusOverride: row.status_override as SATQuestion['statusOverride'],
    statusOverrideJustification: row.status_override_justification || undefined,
    claimedBy: row.claimed_by,
    claimedByName: row.claimed_by_name,
    claimedAt: row.claimed_at,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    requiresSecondReview: !!row.requires_second_review,
    consensusReviews: row.consensus_reviews || [],
    generatorRunId: row.generator_run_id || undefined
  };
}

// Only sends columns that exist on the table; called on every upsert.
export function questionToRow(q: SATQuestion): Partial<QuestionRow> {
  return {
    id: q.id,
    category: q.category,
    sub_skill: q.subSkill || null,
    question_type: q.questionType || 'mcq',
    // Bug fix: this was missing, so editing the "Supporting Graphic URL"
    // field in EditModal appeared to save successfully but was silently
    // dropped — the next reload/realtime echo reverted it because the
    // column was never actually included in the write payload.
    image_url: q.imageUrl ?? null,
    passage: q.passage,
    stimulus: q.stimulus ?? null,
    question: q.question,
    choices: q.choices,
    correct_answer: q.correct_answer,
    explanation: q.explanation,
    module: q.module || null,
    section: q.Section || q.section || null,
    difficulty: q.difficulty,
    generator_run_id: q.generatorRunId || null,
    review_status: q.reviewStatus || 'pending',
    validator_status: q.validatorStatus || null,
    validator_feedback: q.validatorFeedback || null,
    similarity_score: q.similarity_score ?? null,
    similar_question_id: q.similar_question_id || null,
    formation_ok: q.formationOk ?? null,
    answer_ok: q.answerOk ?? null,
    category_ok: q.categoryOk ?? null,
    category_override: q.categoryOverride ?? null,
    difficulty_ok: q.difficultyOk ?? null,
    difficulty_override: q.difficultyOverride ?? null,
    status_override: q.statusOverride ?? null,
    status_override_justification: q.statusOverrideJustification || null,
    comments: q.comments || [],
    claimed_by: q.claimedBy ?? null,
    claimed_by_name: q.claimedByName ?? null,
    claimed_at: q.claimedAt ?? null,
    assigned_to: q.assignedTo ?? null,
    assigned_to_name: q.assignedToName ?? null,
    requires_second_review: !!q.requiresSecondReview,
    consensus_reviews: q.consensusReviews || []
  };
}
