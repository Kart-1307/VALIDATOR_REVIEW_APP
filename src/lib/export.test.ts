import { describe, it, expect } from 'vitest';
import {
  buildProductionBankRecord,
  buildRawExportRecord,
  buildProductionExportRecord,
  toLocalDateKey,
  isApprovedInDateRange,
  isRawInDateRange,
  matchesClaimFilter,
  isQuestionValidated,
  compareValidationTier,
  rowToQuestion,
  QuestionRow
} from './mappers';
import { deriveChecksVerdict, getConsensusResolution } from './consensus';
import type { SATQuestion } from '../types';

// --- Helpers ---------------------------------------------------------------

function makeQuestion(overrides: Partial<SATQuestion> = {}): SATQuestion {
  return {
    id: 'q-1',
    category: 'Craft and Structure',
    subSkill: 'Words in Context',
    questionType: 'mcq',
    passage: 'A short passage for context.',
    stimulus: 'Figure 1: growth curve.',
    question: 'Which choice best completes the text?',
    choices: { A: 'alpha', B: 'beta', C: 'gamma', D: 'delta' },
    correct_answer: 'B',
    explanation: 'The passage establishes a contrast.',
    difficulty: 'medium',
    reviewStatus: 'approved',
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-06T12:30:00.000Z',
    ...overrides
  };
}

// --- 1. Production bank export ---------------------------------------------

describe('buildProductionBankRecord (production_bank)', () => {
  it('produces the repository-specified production schema', () => {
    const rec = buildProductionBankRecord(makeQuestion());
    expect(rec).toMatchObject({
      id: 'q-1',
      stem: 'Which choice best completes the text?',
      question_type: 'mcq',
      correct_answer: 'B',
      category: 'Craft and Structure',
      sub_skill: 'Words in Context',
      difficulty: 'medium',
      stimulus: 'Figure 1: growth curve.',
      status: 'validated'
    });
    expect(typeof rec.validated_at).toBe('string');
  });

  it('keys match the README "Vetted Production Test Bank" schema exactly', () => {
    const keys = Object.keys(buildProductionBankRecord(makeQuestion()));
    expect(keys).toEqual([
      'id',
      'stem',
      'question_type',
      'choices',
      'correct_answer',
      'explanation',
      'category',
      'sub_skill',
      'difficulty',
      'passage',
      'stimulus',
      'image_url',
      'generator_run_id',
      'status',
      'validated_at',
      'created_at'
    ]);
  });

  it('represents a question with a stimulus as ONE record (stimulus embedded, not separate)', () => {
    const records = [buildProductionBankRecord(makeQuestion({ stimulus: 'some data' }))];
    // One question -> exactly one exported record, and the stimulus lives inside it.
    expect(records).toHaveLength(1);
    expect(records[0].stem).toBe('Which choice best completes the text?');
    expect(records[0].stimulus).toBe('some data');
    expect(records[0].passage).toBe('A short passage for context.');
    // No second "stimulus-as-question" record exists.
    expect(records.filter(r => r.stem === 'some data')).toHaveLength(0);
  });

  it('handles a question without a stimulus (no separate record, null field)', () => {
    const rec = buildProductionBankRecord(makeQuestion({ stimulus: null }));
    expect(rec.stimulus).toBeNull();
    expect(rec.passage).toBe('A short passage for context.');
  });
});

// --- 2. Raw export (new batch schema) --------------------------------------

describe('buildRawExportRecord (raw / new batch schema)', () => {
  it('follows the new batch (questions_batch2) schema exactly', () => {
    const keys = Object.keys(buildRawExportRecord(makeQuestion()));
    expect(keys).toEqual([
      'id',
      'category',
      'sub_skill',
      'question_type',
      'image_url',
      'passage',
      'stimulus',
      'question',
      'choices',
      'correct_answer',
      'explanation',
      'module',
      'section',
      'difficulty',
      'generator_run_id',
      'review_status',
      'validator_status',
      'validator_feedback',
      'similarity_score',
      'similar_question_id',
      'formation_ok',
      'answer_ok',
      'category_ok',
      'category_override',
      'difficulty_ok',
      'difficulty_override',
      'status_override',
      'status_override_justification',
      'comments',
      'claimed_by',
      'claimed_by_name',
      'claimed_at',
      'assigned_to',
      'assigned_to_name',
      'requires_second_review',
      'consensus_reviews',
      'created_at',
      'updated_at',
      'batch_label',
      'batch_uploaded_at'
    ]);
  });

  it('preserves validator details (pipeline verdict + validation results)', () => {
    const rec = buildRawExportRecord(
      makeQuestion({
        validatorStatus: 'approved',
        validatorFeedback: 'Looks good.',
        similarity_score: 0.42,
        similar_question_id: 'sat-m-0002',
        formationOk: true,
        answerOk: true,
        categoryOk: false,
        categoryOverride: 'Information and Ideas',
        difficultyOk: false,
        difficultyOverride: 'hard',
        requiresSecondReview: true,
        consensusReviews: [
          {
            validatorId: 'u-1',
            validatorName: 'Alice',
            formationOk: true,
            answerOk: true,
            categoryOk: true,
            difficultyOk: true,
            timestamp: '2026-09-06T09:00:00.000Z'
          }
        ]
      })
    );
    expect(rec.validator_status).toBe('approved');
    expect(rec.validator_feedback).toBe('Looks good.');
    expect(rec.similarity_score).toBe(0.42);
    expect(rec.similar_question_id).toBe('sat-m-0002');
    expect(rec.formation_ok).toBe(true);
    expect(rec.category_override).toBe('Information and Ideas');
    expect(rec.difficulty_override).toBe('hard');
    expect(rec.requires_second_review).toBe(true);
    expect(rec.consensus_reviews).toHaveLength(1);
  });

  it('keeps stimulus embedded as a field of the one complete question (not a separate record)', () => {
    const records = [buildRawExportRecord(makeQuestion({ stimulus: 'chart data' }))];
    expect(records).toHaveLength(1);
    expect(records[0].question).toBe('Which choice best completes the text?');
    expect(records[0].stimulus).toBe('chart data');
    expect(records[0].passage).toBe('A short passage for context.');
  });

  it('includes batch metadata and stable question ID for integration', () => {
    const rec = buildRawExportRecord(
      makeQuestion({
        batchLabel: 'Batch Sept 06',
        batchUploadedAt: '2026-09-06T08:00:00.000Z'
      })
    );
    expect(rec.id).toBe('q-1');
    expect(rec.batch_label).toBe('Batch Sept 06');
    expect(rec.batch_uploaded_at).toBe('2026-09-06T08:00:00.000Z');
  });

  it('nulls batch fields for main-`questions` (non-batch) rows', () => {
    const rec = buildRawExportRecord(makeQuestion());
    expect(rec.batch_label).toBeNull();
    expect(rec.batch_uploaded_at).toBeNull();
  });

  it('preserves all options/answers data', () => {
    const rec = buildRawExportRecord(makeQuestion());
    expect(rec.choices).toEqual({ A: 'alpha', B: 'beta', C: 'gamma', D: 'delta' });
  });
});

// --- 3. Date-wise approved questions export --------------------------------

describe('toLocalDateKey', () => {
  it('returns local yyyy-mm-dd for a timestamp', () => {
    expect(toLocalDateKey('2026-09-06T12:00:00.000Z')).toBe('2026-09-06');
  });

  it('returns null for empty/invalid input', () => {
    expect(toLocalDateKey(null)).toBeNull();
    expect(toLocalDateKey('not-a-date')).toBeNull();
    expect(toLocalDateKey(undefined)).toBeNull();
  });
});

describe('isApprovedInDateRange', () => {
  const approvedOn = (dateKey: string) => makeQuestion({
    reviewStatus: 'approved',
    updatedAt: `${dateKey}T12:00:00.000Z`
  });

  it('includes only approved questions', () => {
    const approved = makeQuestion({ reviewStatus: 'approved', updatedAt: '2026-09-06T12:00:00.000Z' });
    const draft = makeQuestion({ reviewStatus: 'pending', updatedAt: '2026-09-06T12:00:00.000Z' });
    const rejected = makeQuestion({ reviewStatus: 'rejected', updatedAt: '2026-09-06T12:00:00.000Z' });
    expect(isApprovedInDateRange(approved, '2026-09-06', '2026-09-06')).toBe(true);
    expect(isApprovedInDateRange(draft, '2026-09-06', '2026-09-06')).toBe(false);
    expect(isApprovedInDateRange(rejected, '2026-09-06', '2026-09-06')).toBe(false);
  });

  it('filters by a single approval date (inclusive)', () => {
    expect(isApprovedInDateRange(approvedOn('2026-09-06'), '2026-09-06', '2026-09-06')).toBe(true);
    expect(isApprovedInDateRange(approvedOn('2026-09-05'), '2026-09-06', '2026-09-06')).toBe(false);
  });

  it('supports date ranges (inclusive endpoints)', () => {
    expect(isApprovedInDateRange(approvedOn('2026-09-05'), '2026-09-05', '2026-09-07')).toBe(true);
    expect(isApprovedInDateRange(approvedOn('2026-09-06'), '2026-09-05', '2026-09-07')).toBe(true);
    expect(isApprovedInDateRange(approvedOn('2026-09-07'), '2026-09-05', '2026-09-07')).toBe(true);
    expect(isApprovedInDateRange(approvedOn('2026-09-08'), '2026-09-05', '2026-09-07')).toBe(false);
  });

  it('handles a reversed (from > to) range the same as sorted', () => {
    expect(isApprovedInDateRange(approvedOn('2026-09-06'), '2026-09-07', '2026-09-05')).toBe(true);
  });

  it('returns false when there are no results (no question in range)', () => {
    expect(isApprovedInDateRange(approvedOn('2026-09-01'), '2026-09-06', '2026-09-06')).toBe(false);
  });

  it('buckets a question approved around midnight to the correct local approval date', () => {
    // 2026-09-05 23:30 local -> local date 2026-09-05
    expect(isApprovedInDateRange(approvedOn('2026-09-05'), '2026-09-05', '2026-09-05')).toBe(true);
    // 2026-09-06 00:30 local -> local date 2026-09-06
    expect(isApprovedInDateRange(approvedOn('2026-09-06'), '2026-09-06', '2026-09-06')).toBe(true);
  });

  it('returns false when a date is missing/invalid', () => {
    expect(isApprovedInDateRange(makeQuestion({ reviewStatus: 'approved', updatedAt: null, createdAt: null }), '2026-09-06', '2026-09-06')).toBe(false);
    expect(isApprovedInDateRange(approvedOn('2026-09-06'), '', '2026-09-06')).toBe(false);
  });
});

// --- Date-wise RAW export filter -------------------------------------------

describe('isRawInDateRange (raw date-range filter)', () => {
  const createdOn = (dateKey: string, status: SATQuestion['reviewStatus'] = 'pending') =>
    makeQuestion({ reviewStatus: status, createdAt: `${dateKey}T10:00:00.000Z` });

  it('includes raw questions regardless of review status', () => {
    const pending = createdOn('2026-09-06', 'pending');
    const approved = createdOn('2026-09-06', 'approved');
    const rejected = createdOn('2026-09-06', 'rejected');
    expect(isRawInDateRange(pending, '2026-09-06', '2026-09-06')).toBe(true);
    expect(isRawInDateRange(approved, '2026-09-06', '2026-09-06')).toBe(true);
    expect(isRawInDateRange(rejected, '2026-09-06', '2026-09-06')).toBe(true);
  });

  it('filters by a single day (inclusive) using created_at', () => {
    expect(isRawInDateRange(createdOn('2026-09-06'), '2026-09-06', '2026-09-06')).toBe(true);
    expect(isRawInDateRange(createdOn('2026-09-05'), '2026-09-06', '2026-09-06')).toBe(false);
  });

  it('supports multi-day ranges (inclusive endpoints)', () => {
    expect(isRawInDateRange(createdOn('2026-09-05'), '2026-09-05', '2026-09-07')).toBe(true);
    expect(isRawInDateRange(createdOn('2026-09-06'), '2026-09-05', '2026-09-07')).toBe(true);
    expect(isRawInDateRange(createdOn('2026-09-07'), '2026-09-05', '2026-09-07')).toBe(true);
    expect(isRawInDateRange(createdOn('2026-09-08'), '2026-09-05', '2026-09-07')).toBe(false);
  });

  it('handles a reversed (from > to) range the same as sorted', () => {
    expect(isRawInDateRange(createdOn('2026-09-06'), '2026-09-07', '2026-09-05')).toBe(true);
  });

  it('returns false when there are no matching questions in range', () => {
    expect(isRawInDateRange(createdOn('2026-09-01'), '2026-09-06', '2026-09-06')).toBe(false);
  });

  it('returns false when a date is missing or invalid', () => {
    expect(isRawInDateRange(makeQuestion({ createdAt: null, updatedAt: null }), '2026-09-06', '2026-09-06')).toBe(false);
    expect(isRawInDateRange(createdOn('2026-09-06'), '', '2026-09-06')).toBe(false);
    expect(isRawInDateRange(createdOn('2026-09-06'), '2026-09-06', '')).toBe(false);
  });
});

// --- Assignment-state (Unclaimed / Claimed / My Questions) filter -----------

describe('matchesClaimFilter (assignment-state quick filter)', () => {
  const q = (over: { claimedBy?: string | null; assignedTo?: string | null; reviewStatus?: SATQuestion['reviewStatus'] } = {}) => makeQuestion(over);

  it('returns true for everything when claimFilter is "all" or unset', () => {
    expect(matchesClaimFilter(q({ claimedBy: 'u-1' }), 'all', 'u-1')).toBe(true);
    expect(matchesClaimFilter(q({ claimedBy: null, assignedTo: null }), 'all', 'u-1')).toBe(true);
    expect(matchesClaimFilter(q({ claimedBy: 'u-1' }), undefined, 'u-1')).toBe(true);
  });

  it('unclaimed: only questions with no claimant AND no assignee', () => {
    expect(matchesClaimFilter(q({ claimedBy: null, assignedTo: null }), 'unclaimed', 'u-1')).toBe(true);
    expect(matchesClaimFilter(q({ claimedBy: 'u-1', assignedTo: null }), 'unclaimed', 'u-1')).toBe(false);
    expect(matchesClaimFilter(q({ claimedBy: null, assignedTo: 'u-2' }), 'unclaimed', 'u-1')).toBe(false);
    expect(matchesClaimFilter(q({ claimedBy: 'u-1', assignedTo: 'u-2' }), 'unclaimed', 'u-1')).toBe(false);
  });

  it('claimed: only questions that currently have a claimant', () => {
    expect(matchesClaimFilter(q({ claimedBy: 'u-1' }), 'claimed', 'u-1')).toBe(true);
    expect(matchesClaimFilter(q({ claimedBy: 'u-1' }), 'claimed', 'u-2')).toBe(true);
    expect(matchesClaimFilter(q({ claimedBy: null, assignedTo: 'u-2' }), 'claimed', 'u-1')).toBe(false);
    expect(matchesClaimFilter(q({ claimedBy: null, assignedTo: null }), 'claimed', 'u-1')).toBe(false);
  });

  it('mine: matches either claimed by me or assigned to me (while not approved)', () => {
    expect(matchesClaimFilter(q({ claimedBy: 'u-1', assignedTo: null, reviewStatus: 'pending' }), 'mine', 'u-1')).toBe(true);
    expect(matchesClaimFilter(q({ claimedBy: null, assignedTo: 'u-1', reviewStatus: 'pending' }), 'mine', 'u-1')).toBe(true);
    expect(matchesClaimFilter(q({ claimedBy: 'u-2', assignedTo: null, reviewStatus: 'pending' }), 'mine', 'u-1')).toBe(false);
    expect(matchesClaimFilter(q({ claimedBy: null, assignedTo: 'u-1', reviewStatus: 'pending' }), 'mine', 'u-2')).toBe(false);
    expect(matchesClaimFilter(q({ claimedBy: null, assignedTo: null, reviewStatus: 'pending' }), 'mine', 'u-1')).toBe(false);
  });

  it('mine: an approved question leaves the active queue and is not returned on refetch', () => {
    // Requirement: approved questions must disappear from "My Questions". This
    // is enforced at the filter/backend layer (not just hidden client-side), so
    // a later re-query of the filter never resurfaces an item I already approved.
    expect(matchesClaimFilter(q({ claimedBy: 'u-1', assignedTo: null, reviewStatus: 'approved' }), 'mine', 'u-1')).toBe(false);
    expect(matchesClaimFilter(q({ claimedBy: null, assignedTo: 'u-1', reviewStatus: 'approved' }), 'mine', 'u-1')).toBe(false);
    // Needs-revision items are still active work and must keep showing up.
    expect(matchesClaimFilter(q({ claimedBy: 'u-1', assignedTo: null, reviewStatus: 'needs_revision' }), 'mine', 'u-1')).toBe(true);
  });

  it('a released/removed assignment (all fields null) reverts to unclaimed', () => {
    expect(matchesClaimFilter(q({ claimedBy: null, assignedTo: null }), 'unclaimed', 'u-1')).toBe(true);
  });
});

// --- 5. Validation gating (4/4 checklist) and "validated -> last" ordering ---

describe('isQuestionValidated (all four checks answered)', () => {
  it('is false until every check is an explicit Yes/No', () => {
    expect(isQuestionValidated({})).toBe(false);
    expect(isQuestionValidated({ formationOk: true, answerOk: true, categoryOk: true })).toBe(false);
    expect(isQuestionValidated({ formationOk: null, answerOk: true, categoryOk: true, difficultyOk: true })).toBe(false);
    expect(isQuestionValidated({ formationOk: true, answerOk: undefined, categoryOk: true, difficultyOk: true })).toBe(false);
  });

  it('is true once all four are explicit booleans — even a failing checklist counts as validated', () => {
    expect(isQuestionValidated({ formationOk: true, answerOk: true, categoryOk: true, difficultyOk: true })).toBe(true);
    expect(isQuestionValidated({ formationOk: true, answerOk: false, categoryOk: true, difficultyOk: false })).toBe(true);
  });

  it('does not treat non-boolean leftovers as decided (defeats DB/lag surprises)', () => {
    expect(isQuestionValidated({ formationOk: 'true' as unknown as boolean, answerOk: true, categoryOk: true, difficultyOk: true })).toBe(false);
  });
});

describe('compareValidationTier (validated questions move to the last position)', () => {
  const pending = { formationOk: null, answerOk: null, categoryOk: null, difficultyOk: null };
  const validatedFalse = { formationOk: false, answerOk: true, categoryOk: true, difficultyOk: true };
  const validatedTrue = { formationOk: true, answerOk: true, categoryOk: true, difficultyOk: true };

  it('pending items sort strictly before validated items', () => {
    expect(compareValidationTier(pending, validatedTrue)).toBeLessThan(0);
    expect(compareValidationTier(validatedTrue, pending)).toBeGreaterThan(0);
    expect(compareValidationTier(pending, pending)).toBe(0);
    expect(compareValidationTier(validatedTrue, validatedTrue)).toBe(0);
    // A "validated but failing" checklist is still validated — it sinks too.
    expect(compareValidationTier(validatedFalse, validatedTrue)).toBe(0);
  });

  it('a mixed list places every validated item after every pending item', () => {
    const a = { id: 'q-a', ...pending };
    const b = { id: 'q-b', ...validatedTrue };
    const c = { id: 'q-c', ...validatedFalse };
    const d = { id: 'q-d', ...pending };
    const sorted = [a, b, c, d].sort(compareValidationTier).map(x => x.id);
    expect(sorted.slice(0, 2).sort()).toEqual(['q-a', 'q-d']); // pending tier first (order preserved within tier)
    expect(sorted.slice(2).sort()).toEqual(['q-b', 'q-c']); // validated tier last
  });
});

// --- 6. q-sat-1e237d95 regression (claimed, math grid-in, fully reviewed) ---
//
// The graders load a question with this exact id. It is a Math grid-in (no
// A/B/C/D choices), claimed by validator "Renata Okonkwo", and fully reviewed
// with two checks at "No". These tests pin the full logic chain that question
// goes through — mapping, verdict, checklist gating, queue membership and
// list ordering — so the whole review workflow for that id is covered.

describe('q-sat-1e237d95 regression (validator review workflow)', () => {
  const claimedByName = 'Renata Okonkwo';
  const qsat = makeQuestion({
    id: 'q-sat-1e237d95',
    category: 'Problem-Solving and Data Analysis',
    questionType: 'grid_in',
    choices: null,
    correct_answer: '3/4',
    question: 'What is the value of x that satisfies 4x = 3?',
    formationOk: true,
    answerOk: false,
    categoryOk: true,
    difficultyOk: false,
    reviewStatus: 'pending',
    claimedBy: 'v-renata',
    claimedByName
  });

  it('rowToQuestion + deriveChecksVerdict: grid-in row maps cleanly and four answered checks resolve to needs_revision', () => {
    const row: QuestionRow = {
      id: qsat.id,
      category: qsat.category,
      sub_skill: null,
      question_type: 'grid_in',
      image_url: null,
      passage: null,
      stimulus: null,
      question: qsat.question,
      choices: null,
      correct_answer: '3/4',
      explanation: qsat.explanation,
      module: 'M2',
      section: 'math',
      difficulty: 'medium',
      generator_run_id: 'run-2026-09-01',
      review_status: 'pending',
      validator_status: null,
      validator_feedback: null,
      similarity_score: null,
      similar_question_id: null,
      formation_ok: true,
      answer_ok: false,
      category_ok: true,
      difficulty_ok: false,
      category_override: null,
      difficulty_override: null,
      status_override: null,
      status_override_justification: null,
      comments: [],
      claimed_by: 'v-renata',
      claimed_by_name: claimedByName,
      claimed_at: '2026-09-10T09:00:00.000Z',
      assigned_to: 'v-renata',
      assigned_to_name: claimedByName,
      requires_second_review: false,
      consensus_reviews: [],
      created_at: '2026-09-05T10:00:00.000Z',
      updated_at: '2026-09-10T09:30:00.000Z'
    };

    const restored = rowToQuestion(row);
    expect(restored.id).toBe('q-sat-1e237d95');
    expect(restored.choices).toBeNull(); // grid-in: no A/B/C/D -> must not crash mapping
    expect(restored.claimedByName).toBe(claimedByName);
    expect(isQuestionValidated(restored)).toBe(true); // 4/4 answered
    expect(deriveChecksVerdict(restored)).toBe('needs_revision'); // any "No" -> needs revision
  });

  it('after a needs-revision verdict the item stays in the validator queue (claim filter "mine")', () => {
    const q = makeQuestion({ ...qsat, reviewStatus: 'needs_revision' });
    expect(deriveChecksVerdict(q)).toBe('needs_revision');
    expect(getConsensusResolution(q).primaryVerdict).toBe('needs_revision');
    expect(matchesClaimFilter(q, 'mine', 'v-renata')).toBe(true);
  });

  it('after it is approved (all four Yes) it disappears from "My Questions" on the next fetch', () => {
    const approved = makeQuestion({
      ...qsat,
      formationOk: true,
      answerOk: true,
      categoryOk: true,
      difficultyOk: true,
      reviewStatus: 'approved'
    });
    expect(isQuestionValidated(approved)).toBe(true);
    expect(deriveChecksVerdict(approved)).toBe('approved');
    expect(matchesClaimFilter(approved, 'mine', 'v-renata')).toBe(false);
  });

  it('Approve is refused while the checklist is 0/4-3/4, enabled at 4/4 (guard logic)', () => {
    const partial = makeQuestion({ ...qsat, categoryOk: null, difficultyOk: null });
    // Same predicate the handleApprove / handleNeedsRevision guards use:
    // submission is blocked until every check has a real value.
    expect(isQuestionValidated(partial)).toBe(false);
    expect(isQuestionValidated(makeQuestion({ ...qsat, answerOk: true, difficultyOk: true }))).toBe(true);
  });

  it('once validated, q-sat-1e237d95 sinks to the last position of a mixed list', () => {
    const validated = makeQuestion({ ...qsat, answerOk: true, difficultyOk: true, reviewStatus: 'pending' });
    const pending = makeQuestion({
      id: 'q-other-0001',
      formationOk: null,
      answerOk: null,
      categoryOk: null,
      difficultyOk: null,
      reviewStatus: 'pending'
    });
    const sorted = [validated, pending].sort(compareValidationTier).map(x => x.id);
    expect(sorted).toEqual(['q-other-0001', 'q-sat-1e237d95']);
  });
});

// --- 4. Question representation (one complete question) ---------------------

describe('question representation — one complete question per record', () => {
  it('question WITHOUT stimulus -> exactly 1 exported question', () => {
    const noStimulus = [buildRawExportRecord(makeQuestion({ stimulus: null }))];
    const prod = [buildProductionBankRecord(makeQuestion({ stimulus: null }))];
    expect(noStimulus).toHaveLength(1);
    expect(prod).toHaveLength(1);
  });

  it('question WITH stimulus -> exactly 1 exported question (not two records)', () => {
    const raw = [buildRawExportRecord(makeQuestion({ stimulus: 'figure' }))];
    const prod = [buildProductionBankRecord(makeQuestion({ stimulus: 'figure' }))];
    const datewise = [buildProductionExportRecord(makeQuestion({ stimulus: 'figure' }))];
    expect(raw).toHaveLength(1);
    expect(prod).toHaveLength(1);
    expect(datewise).toHaveLength(1);
    // The stimulus is folded into `passage` for the datewise student-app schema.
    expect(datewise[0].passage).toContain('figure');
    expect(datewise[0].passage).toContain('A short passage for context.');
  });

  it('a mapped list of N questions (mix of stimulus / no-stimulus) stays N records overall', () => {
    const list = [
      makeQuestion({ id: 'a', stimulus: 'fig A' }),
      makeQuestion({ id: 'b', stimulus: null }),
      makeQuestion({ id: 'c', stimulus: 'fig C' })
    ];
    expect(list.map(buildRawExportRecord)).toHaveLength(3);
    expect(list.map(buildProductionBankRecord)).toHaveLength(3);
  });
});
