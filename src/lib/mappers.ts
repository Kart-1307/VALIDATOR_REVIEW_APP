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

// Exact production date-range export shape shared by Curator and New Batch.
// `question` is never rebuilt with passage/stimulus, preventing the passage from
// appearing twice.
export function buildProductionExportRecord(q: {
  id: string;
  Section?: string | null;
  section?: string | null;
  category: string;
  question: string;
  passage?: string | null;
  stimulus?: string | null;
  choices: { A: string; B: string; C: string; D: string };
  correct_answer: string;
  explanation: string;
  difficulty: string;
}) {
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
