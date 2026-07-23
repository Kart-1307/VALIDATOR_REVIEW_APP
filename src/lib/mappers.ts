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
