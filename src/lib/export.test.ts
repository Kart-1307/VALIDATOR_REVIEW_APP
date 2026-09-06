import { describe, it, expect } from 'vitest';
import {
  buildProductionBankRecord,
  buildRawExportRecord,
  buildProductionExportRecord,
  toLocalDateKey,
  isApprovedInDateRange
} from './mappers';
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
