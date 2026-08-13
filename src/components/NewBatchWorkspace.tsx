import React, { useState, useEffect, useRef, useMemo } from 'react';
import { SATQuestion, FilterState, StatsSummary, QuestionComment, SortField, SortDirection, ValidatorInvite, MAX_CONSENSUS_REVIEWERS, QuestionSnapshot, ConsensusReview } from '../types';
import StatsGrid from './StatsGrid';
import FiltersPanel from './FiltersPanel';
import StatsCharts from './StatsCharts';
import QuestionCard from './QuestionCard';
import EditModal from './EditModal';
import DuplicateCompareModal from './DuplicateCompareModal';
import QuestionHistoryDrawer from './QuestionHistoryDrawer';
import { supabase, Profile } from '../lib/supabaseClient';
import { rowToQuestion, questionToRow, QuestionRow } from '../lib/mappers';
import { getConsensusResolution } from '../lib/consensus';
import type { Session } from '@supabase/supabase-js';
import {
  Upload,
  Trash2,
  FileText,
  Check,
  Info,
  X,
  Layers,
  History,
  AlertTriangle,
  Undo2,
  GitMerge,
  ChevronDown,
  FileSpreadsheet,
  Download,
  Tag
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';

// The Supabase table this whole workspace reads/writes. Kept 100% isolated
// from the main `questions` table used by the primary Curator tab — this
// component never touches that table except for the explicit "Merge into
// Curator" admin action below.
const TABLE_NAME = 'questions_batch2';

// questions_batch2-only columns (see migration_new_batch_workspace.sql §1b).
// Deliberately NOT added to lib/mappers.ts's shared QuestionRow/questionToRow
// — those are also used to write the main `questions` table, which has no
// batch_label/batch_uploaded_at columns. These thin wrappers layer batch
// tracking on top of the shared mappers for this workspace only.
type Batch2Row = QuestionRow & { batch_label: string | null; batch_uploaded_at: string | null };
const rowToBatch2Question = (row: Batch2Row): SATQuestion => ({
  ...rowToQuestion(row),
  batchLabel: row.batch_label ?? null,
  batchUploadedAt: row.batch_uploaded_at ?? null
});
const questionToBatch2Row = (q: SATQuestion) => ({
  ...questionToRow(q),
  batch_label: q.batchLabel ?? null,
  batch_uploaded_at: q.batchUploadedAt ?? null
});
// Prefix used on bulk_action_snapshots.action_type so "Undo Last Bulk
// Action" here only ever considers snapshots created by *this* workspace,
// even though bulk_action_snapshots is a shared table with the main tab.
const BULK_PREFIX = 'batch2:';

const EMPTY_AUDIT_LOGS: { id: string; timestamp: string; action: string; description: string; user?: string }[] = [];

interface AuditLogEntry {
  id: string;
  timestamp: string;
  rawTimestamp?: string;
  action: string;
  questionId?: string;
  description: string;
  user?: string;
}

interface NewBatchWorkspaceProps {
  session: Session;
  validatorName: string;
  isAdmin: boolean;
  isAuditor: boolean;
  validators: Profile[];
  settings: { consensus_sample_rate: number };
  logs: AuditLogEntry[];
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export default function NewBatchWorkspace({
  session,
  validatorName,
  isAdmin,
  isAuditor,
  validators,
  settings,
  logs,
  showToast
}: NewBatchWorkspaceProps) {
  const [questions, setQuestions] = useState<SATQuestion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const pendingWritesRef = useRef<Map<string, number>>(new Map());

  const [filters, setFilters] = useState<FilterState>({
    search: '',
    section: '',
    category: '',
    difficulty: '',
    status: 'all',
    generatorRunId: '',
    assignedOrClaimedBy: '',
    dateFrom: '',
    dateTo: ''
  });
  const [sortField, setSortField] = useState<SortField>('dateGenerated');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [selectedEditQuestion, setSelectedEditQuestion] = useState<SATQuestion | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // --- Batch tracking (see migration §1b) ---
  const [nextBatchLabel, setNextBatchLabel] = useState('');
  const [batchFilter, setBatchFilter] = useState<string>('all'); // 'all' | 'untagged' | a batchUploadedAt key
  const [removeBatchModalOpen, setRemoveBatchModalOpen] = useState(false);
  const [removeBatchKey, setRemoveBatchKey] = useState<string>('');
  const [removeBatchTypedText, setRemoveBatchTypedText] = useState('');
  const [isRemovingBatch, setIsRemovingBatch] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [duplicateCompareQuestion, setDuplicateCompareQuestion] = useState<SATQuestion | null>(null);
  const [historyDrawerQuestion, setHistoryDrawerQuestion] = useState<SATQuestion | null>(null);

  // --- Export dropdown (Approved / Rejected / Needs Revision / Total Test
  // Bank for this New Batch pool only), each as JSON or Excel — mirrors the
  // main Curator tab's export dropdown, scoped to `questions` (i.e. the
  // questions_batch2 rows this workspace holds), never the main table. ---
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isExportMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setIsExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isExportMenuOpen]);

  // --- Merge into Curator (admin-only) ---
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeScope, setMergeScope] = useState<'approved' | 'selected' | 'all'>('approved');
  const [isMerging, setIsMerging] = useState(false);

  const BULK_TYPE_TO_CONFIRM_THRESHOLD = 10;
  type BulkActionType = 'approve_filtered' | 'reject_filtered' | 'approve_selected' | 'reject_selected';
  const [bulkConfirm, setBulkConfirm] = useState<{ actionType: BulkActionType; status: 'approved' | 'rejected'; ids: string[] } | null>(null);
  const [bulkConfirmTypedText, setBulkConfirmTypedText] = useState('');
  const [isSubmittingBulk, setIsSubmittingBulk] = useState(false);

  const [lastBulkSnapshot, setLastBulkSnapshot] = useState<{
    id: string;
    action_type: string;
    performed_by_name: string | null;
    created_at: string;
    snapshot: SATQuestion[];
  } | null>(null);
  const [isUndoingBulk, setIsUndoingBulk] = useState(false);

  const refreshLastBulkSnapshot = () => {
    supabase
      .from('bulk_action_snapshots')
      .select('*')
      .eq('undone', false)
      .ilike('action_type', `${BULK_PREFIX}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data, error }) => {
        if (!error && data && data.length > 0) {
          const row = data[0];
          setLastBulkSnapshot({
            id: row.id,
            action_type: row.action_type,
            performed_by_name: row.performed_by_name,
            created_at: row.created_at,
            snapshot: row.snapshot as SATQuestion[]
          });
        } else {
          setLastBulkSnapshot(null);
        }
      });
  };

  useEffect(() => {
    refreshLastBulkSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Initial load + realtime subscription, scoped to questions_batch2 only ---
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const PAGE = 1000;
      let from = 0;
      let first = true;
      while (!cancelled) {
        const { data: qRows, error: qError } = await supabase
          .from(TABLE_NAME)
          .select('*')
          .order('created_at', { ascending: false })
          .range(from, from + PAGE - 1);
        if (qError || !qRows) break;
        if (first) {
          setQuestions((qRows as Batch2Row[]).map(rowToBatch2Question));
          first = false;
        } else {
          const incoming = (qRows as Batch2Row[]).map(rowToBatch2Question);
          setQuestions(prev => {
            const seen = new Set(prev.map(q => q.id));
            return [...prev, ...incoming.filter(q => !seen.has(q.id))];
          });
        }
        if (qRows.length < PAGE) break;
        from += PAGE;
      }
      if (!cancelled) setLoaded(true);
    })();

    const channel = supabase
      .channel('questions-batch2-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLE_NAME }, (payload) => {
        setQuestions(prev => {
          if (payload.eventType === 'DELETE') {
            return prev.filter(q => q.id !== (payload.old as any).id);
          }
          const incoming = rowToBatch2Question(payload.new as Batch2Row);
          if ((pendingWritesRef.current.get(incoming.id) || 0) > 0) return prev;
          const exists = prev.some(q => q.id === incoming.id);
          if (!exists) return [...prev, incoming];
          return prev.map(q => {
            if (q.id !== incoming.id) return q;
            return {
              ...incoming,
              // Defensive guard: preserve local text if incoming realtime payload has TOAST-stripped nulls
              passage: incoming.passage ?? q.passage,
              explanation: incoming.explanation || q.explanation,
              stimulus: incoming.stimulus ?? q.stimulus,
              question: incoming.question || q.question,
              choices: (incoming.choices && Object.keys(incoming.choices).length > 0) ? incoming.choices : q.choices,
            };
          });
        });
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  const blockIfAuditor = () => {
    if (isAuditor) {
      showToast('Auditors have read-only access.', 'error');
      return true;
    }
    return false;
  };

  const logEvent = (action: 'approve' | 'reject' | 'reset' | 'edit' | 'upload' | 'clear' | 'note' | 'check', description: string, questionId?: string) => {
    supabase.from('audit_log').insert({
      action,
      question_id: questionId || null,
      description: `[New Batch] ${description}`,
      user_id: session?.user.id || null,
      user_name: validatorName
    }).then(({ error }) => {
      if (error) showToast(`Failed to write audit log: ${error.message}`, 'error');
    });
  };

  const snapshotQuestionBeforeChange = (question: SATQuestion, actionType: string) => {
    supabase.from('question_snapshots').insert({
      question_id: question.id,
      action_type: actionType,
      performed_by: session?.user.id || null,
      performed_by_name: validatorName,
      snapshot: question
    }).then(({ error }) => {
      if (error) showToast(`Could not save a history snapshot: ${error.message}`, 'error');
    });
  };

  const prevMap = new Map(questions.map(q => [q.id, q]));
  const saveQuestions = (updated: SATQuestion[]) => {
    setQuestions(updated);
    const changed = updated.filter(q => prevMap.get(q.id) !== q);
    const newRows = changed.filter(q => !prevMap.has(q.id));
    const existingRows = changed.filter(q => prevMap.has(q.id));

    const bumpPending = (id: string, delta: number) => {
      const map = pendingWritesRef.current;
      const next = (map.get(id) || 0) + delta;
      if (next > 0) map.set(id, next); else map.delete(id);
    };
    changed.forEach(q => bumpPending(q.id, 1));
    const releasePending = (rows: SATQuestion[]) => rows.forEach(q => bumpPending(q.id, -1));

    const insertOp = newRows.length > 0
      ? supabase.from(TABLE_NAME).insert(newRows.map(questionToBatch2Row))
        .then(result => { releasePending(newRows); return result; })
      : null;

    const WRITE_CHUNK_SIZE = 25;
    const runBatchedUpdates = async () => {
      const failures: { error: { message: string } }[] = [];
      for (let i = 0; i < existingRows.length; i += WRITE_CHUNK_SIZE) {
        const chunk = existingRows.slice(i, i + WRITE_CHUNK_SIZE);
        const results = await Promise.all(chunk.map(q =>
          supabase.from(TABLE_NAME).update(questionToBatch2Row(q)).eq('id', q.id)
            .then(result => { releasePending([q]); return result; })
        ));
        results.forEach(r => { if (r.error) failures.push(r as { error: { message: string } }); });
      }
      if (insertOp) {
        const insertResult = await insertOp;
        if (insertResult.error) failures.push(insertResult as { error: { message: string } });
      }
      return failures;
    };

    if (existingRows.length > 0 || insertOp) {
      runBatchedUpdates().then(failures => {
        if (failures.length > 0) showToast(`Failed to save to Supabase: ${failures[0].error.message}`, 'error');
      });
    }
  };

  const deleteAllQuestions = async () => {
    const idsToDelete = questions.map(q => q.id).filter(Boolean);
    if (idsToDelete.length === 0) {
      setQuestions([]);
      return true;
    }
    const { error } = await supabase.from(TABLE_NAME).delete().neq('id', '');
    if (error) {
      showToast(`Failed to wipe the New Batch workspace: ${error.message}`, 'error');
      return false;
    }
    setQuestions([]);
    return true;
  };

  const removeBatch = async (batchKey: string) => {
    if (!isAdmin) { showToast('Only admins can remove a batch.', 'error'); return; }
    const group = batchGroups.find(g => g.key === batchKey);
    const idsToDelete = questions.filter(q => q.batchUploadedAt === batchKey).map(q => q.id);
    if (idsToDelete.length === 0) {
      showToast('No questions found for that batch.', 'error');
      return;
    }
    setIsRemovingBatch(true);
    const { error } = await supabase.from(TABLE_NAME).delete().in('id', idsToDelete);
    setIsRemovingBatch(false);
    if (error) {
      showToast(`Failed to remove batch: ${error.message}`, 'error');
      return;
    }
    setQuestions(prev => prev.filter(q => q.batchUploadedAt !== batchKey));
    setSelectedIds(prev => {
      const next = new Set(prev);
      idsToDelete.forEach(id => next.delete(id));
      return next;
    });
    const label = group?.label || batchKey;
    showToast(`Removed batch "${label}" — ${idsToDelete.length} question(s) deleted from New Batch.`, 'info');
    logEvent('clear', `Removed batch "${label}" (${idsToDelete.length} question(s): ${group?.pending || 0} pending, ${group?.approved || 0} approved, ${group?.rejected || 0} rejected, ${group?.needsRevision || 0} needs revision)`);
    setRemoveBatchModalOpen(false);
    setRemoveBatchKey('');
    setRemoveBatchTypedText('');
    if (batchFilter === batchKey) setBatchFilter('all');
  };

  const deriveOverallStatus = (q: SATQuestion): 'pending' | 'approved' | 'rejected' | 'needs_revision' => {
    if (q.statusOverride) return q.statusOverride;
    const checks = [q.formationOk, q.answerOk, q.categoryOk, q.difficultyOk];
    if (checks.some(c => c === false)) return 'needs_revision';
    return 'pending';
  };

  const handleApprove = (id: string) => {
    if (blockIfAuditor()) return;
    const question = questions.find(q => q.id === id);
    if (question) snapshotQuestionBeforeChange(question, 'approve');
    const updated = questions.map(q => q.id === id ? { ...q, reviewStatus: 'approved' as const } : q);
    saveQuestions(updated);
    showToast('Question item approved.', 'success');
    logEvent('approve', `Approved item "${id}" in "${question?.category || 'General'}"`, id);
  };

  const handleReject = (id: string) => {
    if (blockIfAuditor()) return;
    const question = questions.find(q => q.id === id);
    if (question) snapshotQuestionBeforeChange(question, 'reject');
    const updated = questions.map(q => q.id === id ? { ...q, reviewStatus: 'rejected' as const } : q);
    saveQuestions(updated);
    showToast('Question item rejected.', 'info');
    logEvent('reject', `Rejected item "${id}" in "${question?.category || 'General'}"`, id);
  };

  const handleResetStatus = (id: string) => {
    if (blockIfAuditor()) return;
    const question = questions.find(q => q.id === id);
    if (question) snapshotQuestionBeforeChange(question, 'reset');
    const updated = questions.map(q => q.id === id ? {
      ...q,
      reviewStatus: 'pending' as const,
      formationOk: null,
      answerOk: null,
      categoryOk: null,
      difficultyOk: null,
      statusOverride: null,
      statusOverrideJustification: undefined
    } : q);
    saveQuestions(updated);
    showToast('Question status and checklist reset to pending.', 'info');
    logEvent('reset', `Reset status of item "${id}" back to Pending review`, id);
  };

  const handleSetCheck = (
    id: string,
    updates: Partial<Record<'formationOk' | 'answerOk' | 'categoryOk' | 'difficultyOk', boolean | null>>
  ) => {
    if (blockIfAuditor()) return;
    const question = questions.find(q => q.id === id);
    if (!question) return;
    snapshotQuestionBeforeChange(question, 'check');
    const withCheck = { ...question, ...updates };
    let derived = deriveOverallStatus(withCheck);
    if (question.reviewStatus === 'approved' && derived === 'pending') derived = 'approved';
    const updated = questions.map(q => q.id === id ? { ...withCheck, reviewStatus: derived } : q);
    saveQuestions(updated);

    const labels = {
      formationOk: 'Question formation',
      answerOk: 'Answer correctness',
      categoryOk: 'Category/skill tag',
      difficultyOk: 'Difficulty level'
    };
    Object.entries(updates).forEach(([field, value]) => {
      if (value === null) {
        logEvent('reset', `Reset "${labels[field as keyof typeof labels]}" to unanswered on item "${id}" — overall status now ${derived.replace('_', ' ')}`, id);
        return;
      }
      logEvent('check', `Marked "${labels[field as keyof typeof labels]}" as ${value ? 'correct' : 'incorrect'} on item "${id}" — overall status now ${derived.replace('_', ' ')}`, id);
    });
  };

  const handleCategoryOverride = (id: string, newCategory: string) => {
    if (blockIfAuditor()) return;
    const question = questions.find(q => q.id === id);
    if (!question || !newCategory) return;
    snapshotQuestionBeforeChange(question, 'category_override');
    const withOverride = { ...question, category: newCategory, categoryOverride: newCategory, categoryOk: true };
    const derived = deriveOverallStatus(withOverride);
    const updated = questions.map(q => q.id === id ? { ...withOverride, reviewStatus: derived } : q);
    saveQuestions(updated);
    showToast(`Category reassigned to "${newCategory}".`, 'success');
    logEvent('edit', `Reassigned category on item "${id}" from "${question.category}" to "${newCategory}"`, id);
  };

  const handleDifficultyOverride = (id: string, newDifficulty: 'easy' | 'medium' | 'hard') => {
    if (blockIfAuditor()) return;
    const question = questions.find(q => q.id === id);
    if (!question) return;
    snapshotQuestionBeforeChange(question, 'difficulty_override');
    const withOverride = { ...question, difficulty: newDifficulty, difficultyOverride: newDifficulty, difficultyOk: true };
    const derived = deriveOverallStatus(withOverride);
    const updated = questions.map(q => q.id === id ? { ...withOverride, reviewStatus: derived } : q);
    saveQuestions(updated);
    showToast(`Difficulty reassigned to "${newDifficulty}".`, 'success');
    logEvent('edit', `Reassigned difficulty on item "${id}" from "${question.difficulty}" to "${newDifficulty}"`, id);
  };

  const handleManualOverride = (id: string, status: 'approved' | 'rejected' | 'needs_revision', justification: string) => {
    if (blockIfAuditor()) return;
    if (!justification.trim()) {
      showToast('A justification is required to manually override the status.', 'error');
      return;
    }
    const question = questions.find(q => q.id === id);
    if (question) snapshotQuestionBeforeChange(question, 'manual_override');
    const updated = questions.map(q => q.id === id ? {
      ...q,
      statusOverride: status,
      statusOverrideJustification: justification.trim(),
      reviewStatus: status
    } : q);
    saveQuestions(updated);
    showToast(`Status manually overridden to ${status.replace('_', ' ')}.`, 'info');
    logEvent(
      status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'edit',
      `Manually overrode overall status of item "${id}" to "${status}" — justification: "${justification.trim()}"`,
      id
    );
  };

  const handleClearOverride = (id: string) => {
    if (blockIfAuditor()) return;
    const question = questions.find(q => q.id === id);
    if (!question) return;
    snapshotQuestionBeforeChange(question, 'clear_override');
    const cleared = { ...question, statusOverride: null, statusOverrideJustification: undefined };
    const derived = deriveOverallStatus(cleared);
    const updated = questions.map(q => q.id === id ? { ...cleared, reviewStatus: derived } : q);
    saveQuestions(updated);
    showToast('Manual override cleared — status reverted to auto-derived value.', 'info');
    logEvent('edit', `Cleared manual status override on item "${id}"; reverted to auto-derived "${derived}"`, id);
  };

  const handleAddComment = (id: string, text: string) => {
    if (blockIfAuditor()) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const newComment: QuestionComment = {
      id: `comment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      text: trimmed,
      timestamp: new Date().toISOString(),
      author: validatorName || 'Unnamed Validator'
    };
    const updated = questions.map(q => q.id === id ? { ...q, comments: [...(q.comments || []), newComment] } : q);
    saveQuestions(updated);
    showToast('Comment added.', 'success');
    logEvent('note', `${newComment.author} commented on item "${id}": "${trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed}"`, id);
  };

  const refreshQuestionFromServer = async (id: string) => {
    const { data, error } = await supabase.from(TABLE_NAME).select('*').eq('id', id).single();
    if (!error && data) {
      const fresh = rowToBatch2Question(data as Batch2Row);
      setQuestions(prev => prev.map(q => q.id === id ? { ...q, ...fresh } : q));
    }
  };

  const handleClaimQuestion = async (id: string) => {
    if (blockIfAuditor()) return;
    const question = questions.find(q => q.id === id);
    if (!question) return;
    if (question.claimedBy && question.claimedBy !== session?.user.id) {
      showToast(`Already claimed by ${question.claimedByName || 'another validator'}.`, 'error');
      return;
    }
    const claimedAt = new Date().toISOString();

    // Bump pending writes ref so incoming realtime echo does not clobber state
    const map = pendingWritesRef.current;
    map.set(id, (map.get(id) || 0) + 1);

    const { data, error } = await supabase
      .from(TABLE_NAME)
      .update({ claimed_by: session?.user.id || null, claimed_by_name: validatorName, claimed_at: claimedAt })
      .eq('id', id)
      .is('claimed_by', null)
      .select('id');

    // Release pending write
    const currentPending = (map.get(id) || 0) - 1;
    if (currentPending > 0) map.set(id, currentPending); else map.delete(id);

    if (error) {
      showToast(`Failed to claim: ${error.message}`, 'error');
      return;
    }
    if (!data || data.length === 0) {
      showToast('Someone just claimed this — refreshing.', 'error');
      refreshQuestionFromServer(id);
      return;
    }
    setQuestions(prev => prev.map(q => q.id === id ? { ...q, claimedBy: session?.user.id || null, claimedByName: validatorName, claimedAt } : q));
    logEvent('edit', `${validatorName} claimed item "${id}" for review`, id);
  };

  const handleReleaseClaim = (id: string) => {
    if (blockIfAuditor()) return;
    const updated = questions.map(q => q.id === id ? { ...q, claimedBy: null, claimedByName: null, claimedAt: null } : q);
    saveQuestions(updated);
    logEvent('edit', `${validatorName} released the claim on item "${id}"`, id);
  };

  const handleAssignQuestion = (id: string, validatorId: string | null) => {
    if (blockIfAuditor()) return;
    if (!isAdmin) {
      showToast('Only admins can assign questions to validators.', 'error');
      return;
    }
    const target = validatorId ? validators.find(v => v.id === validatorId) : null;
    const updated = questions.map(q => q.id === id ? { ...q, assignedTo: validatorId, assignedToName: target?.name || null } : q);
    saveQuestions(updated);
    logEvent('edit', target ? `${validatorName} assigned item "${id}" to ${target.name}` : `${validatorName} unassigned item "${id}"`, id);
  };

  const handleSubmitConsensusReview = (id: string, checks: { formationOk: boolean | null; answerOk: boolean | null; categoryOk: boolean | null; difficultyOk: boolean | null }) => {
    if (blockIfAuditor()) return;
    if (!session) return;
    const question = questions.find(q => q.id === id);
    if (!question) return;
    if (question.claimedBy && question.claimedBy === session.user.id) {
      showToast("You're the primary reviewer on this item — second opinions must come from other validators.", 'error');
      return;
    }
    const existing = question.consensusReviews || [];
    const withoutMine = existing.filter(r => r.validatorId !== session.user.id);
    const isNewReviewer = withoutMine.length === existing.length;
    if (isNewReviewer && withoutMine.length >= MAX_CONSENSUS_REVIEWERS) {
      showToast(`This question already has ${MAX_CONSENSUS_REVIEWERS} independent second opinions.`, 'error');
      return;
    }
    const myReview = { validatorId: session.user.id, validatorName, ...checks, timestamp: new Date().toISOString() };
    const updated = questions.map(q => q.id === id ? { ...q, consensusReviews: [...withoutMine, myReview] } : q);
    saveQuestions(updated);
    showToast('Independent consensus review submitted.', 'success');
    logEvent('note', `${validatorName} submitted an independent consensus review on item "${id}"`, id);
  };

  const handleResolveConsensus = (id: string, resolution: 'primary' | 'second_opinion') => {
    if (blockIfAuditor()) return;
    if (!isAdmin) {
      showToast('Only admins can resolve primary vs. second-opinion disagreements.', 'error');
      return;
    }
    const question = questions.find(q => q.id === id);
    if (!question) return;
    snapshotQuestionBeforeChange(question, 'resolve_consensus');
    const { primaryVerdict, secondOpinionVerdict, secondOpinionApproved, secondOpinionNeedsRevision, hasDisagreement } = getConsensusResolution(question);
    if (!hasDisagreement || !secondOpinionVerdict || primaryVerdict === 'pending') {
      showToast('There is no active primary vs. second-opinion disagreement on this item.', 'error');
      return;
    }
    const finalStatus: 'approved' | 'needs_revision' =
      resolution === 'primary' ? (primaryVerdict as 'approved' | 'needs_revision') : (secondOpinionVerdict as 'approved' | 'needs_revision');
    const justification = resolution === 'primary'
      ? `Admin kept the primary reviewer's verdict ("${primaryVerdict.replace('_', ' ')}") over ${secondOpinionApproved + secondOpinionNeedsRevision} second opinions (${secondOpinionApproved} approved / ${secondOpinionNeedsRevision} needs revision).`
      : `Admin applied the second-opinion consensus ("${secondOpinionVerdict.replace('_', ' ')}", ${secondOpinionApproved} approved / ${secondOpinionNeedsRevision} needs revision) over the primary reviewer's verdict ("${primaryVerdict.replace('_', ' ')}").`;
    const updated = questions.map(q => q.id === id ? { ...q, statusOverride: finalStatus, statusOverrideJustification: justification, reviewStatus: finalStatus } : q);
    saveQuestions(updated);
    showToast(`Disagreement resolved — status set to "${finalStatus.replace('_', ' ')}".`, 'success');
    logEvent(
      finalStatus === 'approved' ? 'approve' : 'edit',
      `${validatorName} (admin) resolved a primary vs. second-opinion disagreement on item "${id}" — sided with ${resolution === 'primary' ? 'the primary reviewer' : 'the second opinions'}. ${justification}`,
      id
    );
  };

  const handleViewDuplicate = (question: SATQuestion) => setDuplicateCompareQuestion(question);
  const handleEditTrigger = (q: SATQuestion) => { setSelectedEditQuestion(q); setIsEditModalOpen(true); };

  const handleSaveEditedQuestion = (updatedQuestion: SATQuestion) => {
    if (blockIfAuditor()) return;
    const updated = questions.map(q => q.id === updatedQuestion.id ? updatedQuestion : q);
    saveQuestions(updated);
    showToast('Question changes saved successfully.', 'success');
    logEvent('edit', `Edited question statement / choices for item "${updatedQuestion.id}"`, updatedQuestion.id);
  };

  const handleClearAllQuestions = () => {
    if (blockIfAuditor()) return;
    if (!isAdmin) {
      showToast('Only admins can clear the New Batch workspace.', 'error');
      return;
    }
    setIsClearConfirmOpen(true);
  };

  // --- Filter/sort/stats/pagination — identical logic to the main Curator tab ---
  const stats: StatsSummary = useMemo(() => {
    const s: StatsSummary = { total: questions.length, pending: 0, approved: 0, rejected: 0, needsRevision: 0, bySection: {}, byDifficulty: { easy: 0, medium: 0, hard: 0 }, byCategory: {} };
    questions.forEach(q => {
      if (!q.reviewStatus || q.reviewStatus === 'pending') s.pending++;
      else if (q.reviewStatus === 'approved') s.approved++;
      else if (q.reviewStatus === 'rejected') s.rejected++;
      else if (q.reviewStatus === 'needs_revision') s.needsRevision++;
      const sect = q.Section || q.section || 'Reading_Writing';
      s.bySection[sect] = (s.bySection[sect] || 0) + 1;
      const d = (q.difficulty || 'medium').toLowerCase();
      s.byDifficulty[d] = (s.byDifficulty[d] || 0) + 1;
      const c = q.category || 'General';
      s.byCategory[c] = (s.byCategory[c] || 0) + 1;
    });
    return s;
  }, [questions]);

  interface BatchGroup { key: string; label: string; uploadedAt: string; count: number; pending: number; approved: number; rejected: number; needsRevision: number; }
  const batchGroups = useMemo(() => {
    const map = new Map<string, BatchGroup>();
    questions.forEach(q => {
      const key = q.batchUploadedAt || '';
      if (!key) return; // pre-feature / imported rows with no batch tag — excluded from grouping
      if (!map.has(key)) {
        map.set(key, { key, label: q.batchLabel || key, uploadedAt: key, count: 0, pending: 0, approved: 0, rejected: 0, needsRevision: 0 });
      }
      const g = map.get(key)!;
      g.count++;
      if (!q.reviewStatus || q.reviewStatus === 'pending') g.pending++;
      else if (q.reviewStatus === 'approved') g.approved++;
      else if (q.reviewStatus === 'rejected') g.rejected++;
      else if (q.reviewStatus === 'needs_revision') g.needsRevision++;
    });
    return Array.from(map.values()).sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  }, [questions]);
  const untaggedCount = useMemo(() => questions.filter(q => !q.batchUploadedAt).length, [questions]);

  const uniqueCategories = useMemo(() => Array.from(new Set<string>(questions.map(q => q.category as string))).sort(), [questions]);
  const uniqueSections = useMemo(() => Array.from(new Set<string>(questions.map(q => (q.Section || q.section || 'Reading_Writing') as string))).sort(), [questions]);

  const filteredQuestions = useMemo(() => questions.filter(q => {
    const matchText = filters.search.toLowerCase();
    const searchMatch = !matchText ||
      q.id.toLowerCase().includes(matchText) ||
      q.question.toLowerCase().includes(matchText) ||
      (q.passage && q.passage.toLowerCase().includes(matchText)) ||
      (q.stimulus && q.stimulus.toLowerCase().includes(matchText)) ||
      (q.explanation && q.explanation.toLowerCase().includes(matchText));
    const sectionVal = q.Section || q.section || 'Reading_Writing';
    const sectionMatch = !filters.section || sectionVal === filters.section;
    const categoryMatch = !filters.category || q.category === filters.category;
    const difficultyMatch = !filters.difficulty || (q.difficulty || '').toLowerCase() === filters.difficulty.toLowerCase();
    let statusMatch = true;
    if (filters.status === 'approved') statusMatch = q.reviewStatus === 'approved';
    else if (filters.status === 'rejected') statusMatch = q.reviewStatus === 'rejected';
    else if (filters.status === 'pending') statusMatch = !q.reviewStatus || q.reviewStatus === 'pending';
    else if (filters.status === 'needs_revision') statusMatch = q.reviewStatus === 'needs_revision';
    const runIdMatch = !filters.generatorRunId || (q.generatorRunId || '').toLowerCase().includes(filters.generatorRunId.toLowerCase());
    const assignedMatch = !filters.assignedOrClaimedBy || q.assignedTo === filters.assignedOrClaimedBy || q.claimedBy === filters.assignedOrClaimedBy;
    let dateMatch = true;
    if ((filters.dateFrom || filters.dateTo) && q.createdAt) {
      const created = new Date(q.createdAt).getTime();
      if (filters.dateFrom) dateMatch = dateMatch && created >= new Date(filters.dateFrom).getTime();
      if (filters.dateTo) dateMatch = dateMatch && created <= new Date(filters.dateTo).getTime() + 86400000;
    }
    let batchMatch = true;
    if (batchFilter === 'untagged') batchMatch = !q.batchUploadedAt;
    else if (batchFilter !== 'all') batchMatch = q.batchUploadedAt === batchFilter;
    return searchMatch && sectionMatch && categoryMatch && difficultyMatch && statusMatch && runIdMatch && assignedMatch && dateMatch && batchMatch;
  }), [questions, filters, batchFilter]);

  const difficultyRank: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
  const sortedQuestions = useMemo(() => [...filteredQuestions].sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'dateGenerated':
        cmp = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
        break;
      case 'difficulty':
        cmp = (difficultyRank[(a.difficulty || '').toLowerCase()] ?? 1) - (difficultyRank[(b.difficulty || '').toLowerCase()] ?? 1);
        break;
      case 'category':
        cmp = (a.category || '').localeCompare(b.category || '');
        break;
      case 'id':
      default:
        cmp = a.id.localeCompare(b.id);
        break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  }), [filteredQuestions, sortField, sortDir]);

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  useEffect(() => { setCurrentPage(1); }, [filters, questions.length, batchFilter]);
  const totalPages = Math.max(1, Math.ceil(filteredQuestions.length / pageSize));
  const pageSafe = Math.min(currentPage, totalPages);
  const paginatedQuestions = useMemo(() => sortedQuestions.slice((pageSafe - 1) * pageSize, pageSafe * pageSize), [sortedQuestions, pageSafe, pageSize]);

  const logsByQuestionId = useMemo(() => {
    const map = new Map<string, AuditLogEntry[]>();
    for (const l of logs) {
      if (!l.questionId) continue;
      const bucket = map.get(l.questionId);
      if (bucket) bucket.push(l); else map.set(l.questionId, [l]);
    }
    return map;
  }, [logs]);

  const reviewedCount = stats.approved + stats.rejected;
  const reviewProgressPct = stats.total === 0 ? 0 : Math.round((reviewedCount / stats.total) * 100);
  const hasActiveFilters = !!(filters.search || filters.section || filters.category || filters.difficulty || filters.status !== 'all' || filters.generatorRunId || filters.assignedOrClaimedBy || filters.dateFrom || filters.dateTo);

  const handleResetFilters = () => {
    setFilters({ search: '', section: '', category: '', difficulty: '', status: 'all', generatorRunId: '', assignedOrClaimedBy: '', dateFrom: '', dateTo: '' });
    showToast('All search and dropdown filters cleared.', 'info');
  };

  // --- Selection ---
  const handleToggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const updated = new Set(prev);
      if (updated.has(id)) updated.delete(id); else updated.add(id);
      return updated;
    });
  };
  const handleSelectAllVisible = () => setSelectedIds(new Set(filteredQuestions.map(q => q.id)));
  const handleClearSelection = () => setSelectedIds(new Set());

  const handleApproveAllFiltered = () => {
    if (blockIfAuditor()) return;
    const idsToApprove = filteredQuestions.map(q => q.id);
    if (idsToApprove.length === 0) { showToast('No filtered questions to approve.', 'error'); return; }
    setBulkConfirmTypedText('');
    setBulkConfirm({ actionType: 'approve_filtered', status: 'approved', ids: idsToApprove });
  };
  const handleRejectAllFiltered = () => {
    if (blockIfAuditor()) return;
    const idsToReject = filteredQuestions.map(q => q.id);
    if (idsToReject.length === 0) { showToast('No filtered questions to reject.', 'error'); return; }
    setBulkConfirmTypedText('');
    setBulkConfirm({ actionType: 'reject_filtered', status: 'rejected', ids: idsToReject });
  };
  const handleApproveSelected = () => {
    if (blockIfAuditor()) return;
    if (selectedIds.size === 0) { showToast('No questions selected.', 'error'); return; }
    setBulkConfirmTypedText('');
    setBulkConfirm({ actionType: 'approve_selected', status: 'approved', ids: Array.from(selectedIds) });
  };
  const handleRejectSelected = () => {
    if (blockIfAuditor()) return;
    if (selectedIds.size === 0) { showToast('No questions selected.', 'error'); return; }
    setBulkConfirmTypedText('');
    setBulkConfirm({ actionType: 'reject_selected', status: 'rejected', ids: Array.from(selectedIds) });
  };

  const BULK_ACTION_LOG_DESCRIPTIONS: Record<BulkActionType, (n: number) => string> = {
    approve_filtered: n => `Bulk approved ${n} filtered item(s)`,
    reject_filtered: n => `Bulk rejected ${n} filtered item(s)`,
    approve_selected: n => `Bulk approved ${n} manually selected item(s)`,
    reject_selected: n => `Bulk rejected ${n} manually selected item(s)`
  };

  const executeBulkConfirm = async () => {
    if (!bulkConfirm) return;
    const { actionType, status, ids } = bulkConfirm;
    setIsSubmittingBulk(true);
    const snapshotRows = questions.filter(q => ids.includes(q.id));
    const { data: snapRow, error: snapError } = await supabase
      .from('bulk_action_snapshots')
      .insert({
        action_type: `${BULK_PREFIX}${actionType}`,
        performed_by: session?.user.id || null,
        performed_by_name: validatorName,
        question_ids: ids,
        snapshot: snapshotRows
      })
      .select()
      .single();
    if (snapError) {
      showToast(`Could not save an undo snapshot, action cancelled: ${snapError.message}`, 'error');
      setIsSubmittingBulk(false);
      return;
    }
    const updated = questions.map(q => ids.includes(q.id) ? { ...q, reviewStatus: status } : q);
    saveQuestions(updated);
    logEvent(status === 'approved' ? 'approve' : 'reject', BULK_ACTION_LOG_DESCRIPTIONS[actionType](ids.length));
    showToast(`${status === 'approved' ? 'Approved' : 'Rejected'} ${ids.length} question(s). You can undo this from the toolbar.`, status === 'approved' ? 'success' : 'info');
    if (actionType === 'approve_selected' || actionType === 'reject_selected') setSelectedIds(new Set());
    setLastBulkSnapshot({ id: snapRow.id, action_type: snapRow.action_type, performed_by_name: snapRow.performed_by_name, created_at: snapRow.created_at, snapshot: snapshotRows });
    setBulkConfirm(null);
    setIsSubmittingBulk(false);
  };

  const handleUndoLastBulkAction = async () => {
    if (!lastBulkSnapshot) return;
    if (blockIfAuditor()) return;
    setIsUndoingBulk(true);
    const snapshotQuestions = lastBulkSnapshot.snapshot;
    const snapshotMap = new Map(snapshotQuestions.map(q => [q.id, q]));
    const restored = questions.map(q => snapshotMap.has(q.id) ? snapshotMap.get(q.id)! : q);
    saveQuestions(restored);
    logEvent('reset', `Undid bulk action "${lastBulkSnapshot.action_type.replace(BULK_PREFIX, '')}" (by ${lastBulkSnapshot.performed_by_name || 'unknown'}) — restored ${snapshotQuestions.length} item(s) to their exact prior state`);
    const { error } = await supabase.from('bulk_action_snapshots').update({ undone: true, undone_at: new Date().toISOString() }).eq('id', lastBulkSnapshot.id);
    if (error) {
      showToast(`Restored locally, but failed to mark the snapshot as undone: ${error.message}`, 'error');
    } else {
      showToast(`Restored ${snapshotQuestions.length} question(s) to their state before that bulk action.`, 'info');
    }
    setLastBulkSnapshot(null);
    setIsUndoingBulk(false);
    refreshLastBulkSnapshot();
  };

  const handleRestoreQuestionSnapshot = async (snap: QuestionSnapshot) => {
    if (blockIfAuditor()) return false;
    if (!isAdmin) {
      showToast('Only admins can restore a question to a past state.', 'error');
      return false;
    }
    const restoredQuestion = snap.snapshot;
    const updated = questions.map(q => q.id === restoredQuestion.id ? restoredQuestion : q);
    saveQuestions(updated);
    logEvent('reset', `Admin ${validatorName} restored item "${restoredQuestion.id}" to its state from before a "${snap.action_type}" action (snapshot taken ${new Date(snap.created_at).toLocaleString()}, originally by ${snap.performed_by_name || 'unknown'})`, restoredQuestion.id);
    const { error } = await supabase.from('question_snapshots').update({ restored: true }).eq('id', snap.id);
    if (error) {
      showToast(`Restored locally, but failed to mark the snapshot as restored: ${error.message}`, 'error');
    } else {
      showToast(`Restored item "${restoredQuestion.id}" to its state from before that action.`, 'info');
    }
    return true;
  };

  // --- Upload (admin-only) ---
  const isInConsensusSample = (id: string, rate: number): boolean => {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return (hash % 100) < Math.round(rate * 100);
  };

  const sanitizeQuestion = (q: any, idx: number): SATQuestion => {
    const fallbackId = `curated-sat-batch2-${Date.now()}-${idx + 1}`;
    const id = q.id || fallbackId;
    return {
      id,
      category: q.category || 'General',
      subSkill: q.subSkill || q.sub_skill || undefined,
      passage: q.passage || null,
      stimulus: q.stimulus || null,
      question: q.question || 'Missing question text',
      choices: q.choices || { A: '', B: '', C: '', D: '' },
      correct_answer: q.correct_answer || 'A',
      explanation: q.explanation || 'No explanation provided.',
      difficulty: q.difficulty || 'medium',
      module: q.module,
      Section: q.Section || q.section || 'Reading_Writing',
      section: q.Section || q.section || 'Reading_Writing',
      reviewStatus: q.reviewStatus || 'pending',
      createdAt: q.createdAt || new Date().toISOString(),
      generatorRunId: q.generatorRunId || q.generator_run_id || undefined,
      validatorStatus: q.status || q.validatorStatus || q.validator_status || undefined,
      validatorFeedback: q.validatorFeedback || q.validator_feedback || q.feedback || undefined,
      similarity_score: q.similarity_score,
      similar_question_id: q.similar_question_id,
      reviewerNote: q.reviewerNote || q.reviewer_note || undefined,
      comments: Array.isArray(q.comments)
        ? q.comments
        : (q.reviewerNote || q.reviewer_note)
          ? [{ id: `comment-imported-${idx}`, text: q.reviewerNote || q.reviewer_note, timestamp: q.createdAt || new Date().toISOString(), author: 'Imported' }]
          : [],
      formationOk: q.formationOk ?? null,
      answerOk: q.answerOk ?? null,
      categoryOk: q.categoryOk ?? null,
      categoryOverride: q.categoryOverride ?? null,
      difficultyOk: q.difficultyOk ?? null,
      difficultyOverride: q.difficultyOverride ?? null,
      statusOverride: q.statusOverride ?? null,
      statusOverrideJustification: q.statusOverrideJustification || undefined,
      claimedBy: q.claimedBy ?? null,
      claimedByName: q.claimedByName ?? null,
      claimedAt: q.claimedAt ?? null,
      assignedTo: q.assignedTo ?? null,
      assignedToName: q.assignedToName ?? null,
      requiresSecondReview: q.requiresSecondReview ?? isInConsensusSample(id, settings.consensus_sample_rate || 0.1),
      consensusReviews: Array.isArray(q.consensusReviews) ? q.consensusReviews : []
    };
  };

  const parseQuestionFile = (file: File): Promise<{ file: string; sanitized: SATQuestion[] }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const data = JSON.parse(event.target?.result as string);
          if (!Array.isArray(data)) {
            reject(`"${file.name}" is not a valid JSON array of questions.`);
            return;
          }
          resolve({ file: file.name, sanitized: data.map((q: any, idx) => sanitizeQuestion(q, idx)) });
        } catch (err) {
          reject(`Failed to parse "${file.name}" — invalid JSON.`);
        }
      };
      reader.onerror = () => reject(`Could not read "${file.name}".`);
      reader.readAsText(file);
    });
  };

  const readFiles = async (files: File[]) => {
    const jsonFiles = files.filter(f => f.name.toLowerCase().endsWith('.json'));
    if (jsonFiles.length === 0) {
      showToast('No .json files found in your selection/drop.', 'error');
      return;
    }
    const results = await Promise.allSettled(jsonFiles.map(parseQuestionFile));
    const succeeded = results.filter((r): r is PromiseFulfilledResult<{ file: string; sanitized: SATQuestion[] }> => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (succeeded.length === 0) {
      showToast(failed.length > 0 ? String(failed[0].reason) : 'Failed to load any files.', 'error');
      return;
    }
    // One batch identity per upload call: batchUploadedAt is the unique key
    // (used for filtering/deletion), batchLabel is what's shown in the UI.
    const batchUploadedAt = new Date().toISOString();
    const trimmedLabel = nextBatchLabel.trim();
    const batchLabel = trimmedLabel || new Date().toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });

    const merged = new Map<string, SATQuestion>();
    questions.forEach(q => merged.set(q.id, q));
    let incomingCount = 0;
    let updatedCount = 0;
    succeeded.forEach(({ value }) => {
      value.sanitized.forEach(q => {
        const existing = merged.get(q.id);
        if (existing) {
          // Already in the pool — this is a content update, not a new
          // question, so it keeps whichever batch first introduced it.
          updatedCount++;
          merged.set(q.id, { ...q, batchLabel: existing.batchLabel ?? null, batchUploadedAt: existing.batchUploadedAt ?? null });
        } else {
          incomingCount++;
          merged.set(q.id, { ...q, batchLabel, batchUploadedAt });
        }
      });
    });
    const mergedList = Array.from(merged.values());
    saveQuestions(mergedList);
    setNextBatchLabel('');
    const fileNames = succeeded.map(s => s.value.file).join(', ');
    const summary = `Merged ${succeeded.length} file(s) [${fileNames}] into New Batch as batch "${batchLabel}" — ${incomingCount} new item(s) tagged to this batch, ${updatedCount} existing item(s) updated by id (kept their original batch). New Batch workspace now has ${mergedList.length} total.`;
    logEvent('upload', summary);
    if (failed.length > 0) {
      const failureReasons = failed.map(f => String(f.reason)).join(' ');
      showToast(`${summary} ⚠️ ${failed.length} file(s) failed: ${failureReasons}`, 'info');
    } else {
      showToast(summary, 'success');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (blockIfAuditor()) return;
    if (!isAdmin) { showToast('Only admins can upload JSON files.', 'error'); return; }
    const files = e.target.files;
    if (!files || files.length === 0) return;
    readFiles(Array.from(files));
    e.target.value = '';
  };
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (blockIfAuditor()) return;
    if (!isAdmin) { showToast('Only admins can upload JSON files.', 'error'); return; }
    const files = e.dataTransfer.files;
    if (files && files.length > 0) readFiles(Array.from(files));
  };

  // --- Merge into Curator (admin-only, on demand — nothing moves automatically) ---
  const runMerge = async () => {
    if (!isAdmin) {
      showToast('Only admins can merge into the main Curator pool.', 'error');
      return;
    }
    let source: SATQuestion[];
    if (mergeScope === 'approved') source = questions.filter(q => q.reviewStatus === 'approved');
    else if (mergeScope === 'selected') source = questions.filter(q => selectedIds.has(q.id));
    else source = questions;

    if (source.length === 0) {
      showToast('No questions match that merge scope.', 'error');
      return;
    }

    setIsMerging(true);
    const rows = source.map(questionToRow);
    const { error } = await supabase.from('questions').upsert(rows, { onConflict: 'id' });
    setIsMerging(false);

    if (error) {
      showToast(`Merge failed: ${error.message}`, 'error');
      return;
    }

    showToast(`Merged ${source.length} question(s) from New Batch into the main Curator pool.`, 'success');
    logEvent('note', `Merged ${source.length} question(s) from New Batch into the main Curator "questions" pool (scope: ${mergeScope})`);
    setMergeModalOpen(false);
  };

  // ---------------------------------------------------------------------
  // Bucketed exports (Approved / Rejected / Needs Revision / Total New
  // Batch Pool), each available as JSON or Excel from the "Export"
  // dropdown. Mirrors the main Curator tab's export feature exactly, but
  // scoped to this workspace's own `questions` state (questions_batch2),
  // so it never touches or reads the main `questions` table.
  // ---------------------------------------------------------------------
  type ExportBucket = 'approved' | 'rejected' | 'needs_revision' | 'all';

  const EXPORT_BUCKET_LABELS: Record<ExportBucket, string> = {
    approved: 'Approved Questions',
    rejected: 'Rejected Questions',
    needs_revision: 'Needs Revision Questions',
    all: 'Total New Batch Pool'
  };

  const EXPORT_BUCKET_FILENAMES: Record<ExportBucket, string> = {
    approved: 'new-batch-approved-questions',
    rejected: 'new-batch-rejected-questions',
    needs_revision: 'new-batch-needs-revision-questions',
    all: 'new-batch-total-pool'
  };

  const questionsInBucket = (bucket: ExportBucket) =>
    bucket === 'all' ? questions : questions.filter(q => (q.reviewStatus || 'pending') === bucket);

  // Same record shape as the main Curator tab's export, so downstream
  // consumers (e.g. the pipeline that ingests these files) don't need a
  // separate parser just because the batch happened to come through the
  // isolated New Batch tab.
  const buildExportRecord = (q: SATQuestion) => ({
    id: q.id,
    section: q.Section || q.section || null,
    category: q.category,
    subSkill: q.subSkill || null,
    questionType: q.questionType || 'mcq',
    difficulty: q.difficulty,
    passage: q.passage,
    stimulus: q.stimulus || null,
    imageUrl: q.imageUrl || null,
    question: q.question,
    choices: q.choices,
    correct_answer: q.correct_answer,
    explanation: q.explanation,
    reviewStatus: q.reviewStatus || 'pending',
    reviewedBy: q.claimedByName || q.assignedToName || null,
    claimedBy: q.claimedByName || null,
    claimedAt: q.claimedAt || null,
    assignedTo: q.assignedToName || null,
    checklist: {
      formationOk: q.formationOk ?? null,
      answerOk: q.answerOk ?? null,
      categoryOk: q.categoryOk ?? null,
      categoryOverride: q.categoryOverride || null,
      difficultyOk: q.difficultyOk ?? null,
      difficultyOverride: q.difficultyOverride || null
    },
    statusOverride: q.statusOverride || null,
    statusOverrideJustification: q.statusOverrideJustification || null,
    reviewerNote: q.reviewerNote || null,
    comments: q.comments || [],
    consensusReviews: q.consensusReviews || [],
    requiresSecondReview: q.requiresSecondReview || false,
    pipelineValidatorStatus: q.validatorStatus || null,
    pipelineValidatorFeedback: q.validatorFeedback || null,
    similarityScore: typeof q.similarity_score === 'number' ? q.similarity_score : null,
    similarQuestionId: q.similar_question_id || null,
    generatorRunId: q.generatorRunId || null,
    createdAt: q.createdAt || null
  });

  const exportBucketAsJson = (bucket: ExportBucket) => {
    if (!isAdmin) {
      showToast('Only admins can export questions.', 'error');
      return;
    }
    const list = questionsInBucket(bucket);
    if (list.length === 0) {
      showToast(`No ${EXPORT_BUCKET_LABELS[bucket].toLowerCase()} to export.`, 'error');
      return;
    }
    const records = list.map(buildExportRecord);

    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', url);
    downloadAnchor.setAttribute('download', `${EXPORT_BUCKET_FILENAMES[bucket]}-${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    setTimeout(() => {
      document.body.removeChild(downloadAnchor);
      URL.revokeObjectURL(url);
    }, 100);

    showToast(`Exported ${records.length} question(s) — ${EXPORT_BUCKET_LABELS[bucket]} (JSON).`, 'success');
    logEvent('note', `Exported ${records.length} question(s) — ${EXPORT_BUCKET_LABELS[bucket]} (JSON)`);
    setIsExportMenuOpen(false);
  };

  // Comments/consensus reviews are arrays on the question, but a spreadsheet
  // cell can only hold flat text — these two flatten them into a single,
  // still-readable cell instead of silently dropping the data.
  const flattenComments = (comments: QuestionComment[]) =>
    comments.length === 0
      ? ''
      : comments.map(c => `${c.author} (${new Date(c.timestamp).toLocaleString()}): ${c.text}`).join(' | ');

  const flattenConsensusReviews = (reviews: ConsensusReview[]) =>
    reviews.length === 0
      ? ''
      : reviews
          .map(r => {
            const mark = (v: boolean | null) => (v === true ? '✓' : v === false ? '✗' : '?');
            return `${r.validatorName}: form${mark(r.formationOk)} ans${mark(r.answerOk)} cat${mark(r.categoryOk)} diff${mark(r.difficultyOk)}`;
          })
          .join(' | ');

  const exportBucketAsExcel = (bucket: ExportBucket) => {
    if (!isAdmin) {
      showToast('Only admins can export questions.', 'error');
      return;
    }
    const list = questionsInBucket(bucket);
    if (list.length === 0) {
      showToast(`No ${EXPORT_BUCKET_LABELS[bucket].toLowerCase()} to export.`, 'error');
      return;
    }

    const rows = list.map(q => ({
      ID: q.id,
      Section: q.Section || q.section || '',
      Category: q.category,
      'Sub Skill': q.subSkill || '',
      'Question Type': q.questionType || 'mcq',
      Difficulty: q.difficulty,
      Passage: q.passage || '',
      Stimulus: q.stimulus || '',
      Question: q.question,
      'Choice A': q.choices?.A || '',
      'Choice B': q.choices?.B || '',
      'Choice C': q.choices?.C || '',
      'Choice D': q.choices?.D || '',
      'Correct Answer': q.correct_answer,
      Explanation: q.explanation,
      'Review Status': q.reviewStatus || 'pending',
      'Reviewed By': q.claimedByName || q.assignedToName || '',
      'Formation OK': q.formationOk === true ? 'Yes' : q.formationOk === false ? 'No' : '',
      'Answer OK': q.answerOk === true ? 'Yes' : q.answerOk === false ? 'No' : '',
      'Category OK': q.categoryOk === true ? 'Yes' : q.categoryOk === false ? 'No' : '',
      'Category Override': q.categoryOverride || '',
      'Difficulty OK': q.difficultyOk === true ? 'Yes' : q.difficultyOk === false ? 'No' : '',
      'Difficulty Override': q.difficultyOverride || '',
      'Status Override': q.statusOverride || '',
      'Status Override Justification': q.statusOverrideJustification || '',
      'Reviewer Note': q.reviewerNote || '',
      Comments: flattenComments(q.comments || []),
      'Consensus Reviews': flattenConsensusReviews(q.consensusReviews || []),
      'Pipeline Validator Status': q.validatorStatus || '',
      'Pipeline Validator Feedback': q.validatorFeedback || '',
      'Generator Run ID': q.generatorRunId || '',
      'Created At': q.createdAt || ''
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet['!cols'] = [
      { wch: 14 }, // ID
      { wch: 10 }, // Section
      { wch: 18 }, // Category
      { wch: 18 }, // Sub Skill
      { wch: 12 }, // Question Type
      { wch: 10 }, // Difficulty
      { wch: 40 }, // Passage
      { wch: 30 }, // Stimulus
      { wch: 40 }, // Question
      { wch: 25 }, // Choice A
      { wch: 25 }, // Choice B
      { wch: 25 }, // Choice C
      { wch: 25 }, // Choice D
      { wch: 14 }, // Correct Answer
      { wch: 40 }, // Explanation
      { wch: 14 }, // Review Status
      { wch: 18 }, // Reviewed By
      { wch: 12 }, // Formation OK
      { wch: 12 }, // Answer OK
      { wch: 12 }, // Category OK
      { wch: 18 }, // Category Override
      { wch: 12 }, // Difficulty OK
      { wch: 18 }, // Difficulty Override
      { wch: 14 }, // Status Override
      { wch: 30 }, // Status Override Justification
      { wch: 25 }, // Reviewer Note
      { wch: 45 }, // Comments
      { wch: 45 }, // Consensus Reviews
      { wch: 20 }, // Pipeline Validator Status
      { wch: 30 }, // Pipeline Validator Feedback
      { wch: 18 }, // Generator Run ID
      { wch: 20 }, // Created At
    ];

    const workbook = XLSX.utils.book_new();
    // Sheet names are capped at 31 characters in Excel.
    XLSX.utils.book_append_sheet(workbook, worksheet, EXPORT_BUCKET_LABELS[bucket].slice(0, 31));
    XLSX.writeFile(workbook, `${EXPORT_BUCKET_FILENAMES[bucket]}-${Date.now()}.xlsx`);

    showToast(`Exported ${rows.length} question(s) — ${EXPORT_BUCKET_LABELS[bucket]} (Excel).`, 'success');
    logEvent('note', `Exported ${rows.length} question(s) — ${EXPORT_BUCKET_LABELS[bucket]} (Excel)`);
    setIsExportMenuOpen(false);
  };

  return (
    <>
      {/* Banner + upload */}
      <div className="mb-6 bg-gradient-to-r from-[#fafafa] to-[#f2f2f3] text-zinc-900 rounded-2xl p-6 relative flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border border-[#e4e4e7] shadow-sm">
        <div className="relative z-10 space-y-1">
          <h2 className="text-base font-bold tracking-tight">New Batch — Isolated Review Queue</h2>
          <p className="text-xs text-zinc-500 font-normal leading-relaxed max-w-xl">
            Upload a fresh batch of generated questions here for a completely separate validation pass — this pool never touches the main Curator data until you explicitly merge it in.
          </p>
        </div>
        <div className="relative z-10 flex gap-2 w-full md:w-auto">
          {isAdmin && (
            <>
              <div className="relative flex-1 md:flex-none md:w-52">
                <Tag className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={nextBatchLabel}
                  onChange={(e) => setNextBatchLabel(e.target.value)}
                  placeholder="Batch label (optional)"
                  title="Name for this upload's batch — shown to validators as a filter. Leave blank to use the upload date/time."
                  className="w-full pl-8 pr-2.5 py-2.5 text-xs font-semibold rounded-xl border border-[#e4e4e7] bg-white text-zinc-900 placeholder:text-zinc-500 placeholder:font-normal focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                />
              </div>
              <input type="file" accept=".json" multiple ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
              <button
                onClick={() => fileInputRef.current?.click()}
                title="Select one or more JSON files to upload into the New Batch pool"
                className="flex-1 md:flex-none flex items-center justify-center gap-1.5 px-4 py-2.5 bg-[#ececed] hover:bg-[#e4e4e7] text-zinc-900 text-xs font-bold rounded-xl border border-[#e4e4e7] transition-all cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5 text-zinc-600" /> Upload New Batch JSON
              </button>
              <button
                onClick={() => setMergeModalOpen(true)}
                disabled={questions.length === 0}
                title="Push validated items from this batch into the main Curator questions table"
                className={`flex-1 md:flex-none flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-bold rounded-xl border transition-all cursor-pointer ${questions.length === 0 ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed' : 'bg-[#6366f1] hover:bg-indigo-700 text-white border-[#6366f1] shadow-xs'}`}
              >
                <GitMerge className="w-3.5 h-3.5" /> Merge into Curator
              </button>

              {/* Bucketed export dropdown: Approved / Rejected / Needs
                  Revision / Total New Batch Pool, each as JSON or Excel —
                  mirrors the main Curator tab's export dropdown, scoped to
                  this workspace's own questions_batch2 pool. */}
              <div className="relative" ref={exportMenuRef}>
                <button
                  onClick={() => setIsExportMenuOpen(open => !open)}
                  disabled={questions.length === 0}
                  title="Export questions from this New Batch pool"
                  className={`flex-1 md:flex-none flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-bold rounded-xl border transition-all cursor-pointer ${questions.length === 0
                      ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed'
                      : 'bg-emerald-700 hover:bg-emerald-600 text-white border-emerald-700 shadow-xs'
                    }`}
                >
                  <Download className="w-3.5 h-3.5" />
                  Export
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExportMenuOpen ? 'rotate-180' : ''}`} />
                </button>

                {isExportMenuOpen && (
                  <div className="absolute right-0 mt-1.5 w-[22rem] bg-white border border-[#e4e4e7] rounded-xl shadow-2xl z-30 overflow-hidden">
                    {(['approved', 'rejected', 'needs_revision', 'all'] as ExportBucket[]).map((bucket, idx) => {
                      const count = questionsInBucket(bucket).length;
                      const isEmpty = count === 0;
                      return (
                        <div
                          key={bucket}
                          className={`flex items-center justify-between gap-2 px-3.5 py-2.5 ${idx !== 0 ? 'border-t border-[#e4e4e7]' : ''}`}
                        >
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-zinc-900 truncate">{EXPORT_BUCKET_LABELS[bucket]}</p>
                            <p className="text-[11px] text-zinc-500">{count} question{count === 1 ? '' : 's'}</p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => exportBucketAsJson(bucket)}
                              disabled={isEmpty}
                              title={`Download ${EXPORT_BUCKET_LABELS[bucket]} as JSON`}
                              className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold rounded-lg border transition-all cursor-pointer ${isEmpty
                                  ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed'
                                  : 'bg-[#f2f2f3] text-zinc-600 border-[#e4e4e7] hover:bg-zinc-900 hover:text-white'
                                }`}
                            >
                              <FileText className="w-3 h-3" /> JSON
                            </button>
                            <button
                              onClick={() => exportBucketAsExcel(bucket)}
                              disabled={isEmpty}
                              title={`Download ${EXPORT_BUCKET_LABELS[bucket]} as Excel`}
                              className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold rounded-lg border transition-all cursor-pointer ${isEmpty
                                  ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed'
                                  : 'bg-green-50 text-green-700 border-green-200 hover:bg-green-700 hover:text-white'
                                }`}
                            >
                              <FileSpreadsheet className="w-3 h-3" /> XLSX
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <button
                onClick={handleClearAllQuestions}
                title="Clear the New Batch workspace"
                className="p-2.5 text-zinc-500 hover:text-rose-600 border border-[#e4e4e7] hover:bg-rose-50 rounded-xl transition-all cursor-pointer bg-[#fafafa]"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {isAdmin && (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`transition-all rounded-2xl border-2 border-dashed flex flex-col items-center justify-center p-8 mb-6 ${dragOver ? 'border-[#6366f1] bg-[#f2f2f3]/50 py-12 scale-[0.99] text-[#4f46e5] shadow-inner' : 'border-[#e4e4e7] bg-transparent py-4 text-zinc-500'}`}
        >
          <div className="flex flex-col sm:flex-row items-center gap-3">
            <Upload className={`w-5 h-5 ${dragOver ? 'text-[#4f46e5] animate-bounce' : 'text-zinc-500'}`} />
            <p className="text-xs font-medium text-center">
              {dragOver ? 'Drop one or more New Batch JSON files here!' : 'Drag and drop New Batch JSON files onto this panel — isolated from the main Curator pool.'}
            </p>
          </div>
        </div>
      )}

      <StatsGrid stats={stats} activeStatusFilter={filters.status} onSelectStatusFilter={(status) => setFilters(prev => ({ ...prev, status }))} />
      <StatsCharts stats={stats} />
      <FiltersPanel
        filters={filters}
        onChangeFilters={(updates) => setFilters(prev => ({ ...prev, ...updates }))}
        categories={uniqueCategories}
        sections={uniqueSections}
        onResetAll={handleResetFilters}
        hasActiveFilters={hasActiveFilters}
        validators={validators}
      />

      {batchGroups.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3 bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-3">
          <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-600 shrink-0">
            <Layers className="w-3.5 h-3.5" /> Batch:
          </div>
          <select
            value={batchFilter}
            onChange={(e) => setBatchFilter(e.target.value)}
            className="flex-1 min-w-[14rem] px-3 py-2 text-xs font-semibold rounded-lg border border-[#e4e4e7] bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] cursor-pointer"
          >
            <option value="all">All batches ({questions.length})</option>
            {batchGroups.map(g => (
              <option key={g.key} value={g.key}>
                {g.label} — {new Date(g.uploadedAt).toLocaleString()} ({g.count})
              </option>
            ))}
            {untaggedCount > 0 && <option value="untagged">Untagged / legacy items ({untaggedCount})</option>}
          </select>
          {isAdmin && batchFilter !== 'all' && batchFilter !== 'untagged' && (
            <button
              onClick={() => { setRemoveBatchKey(batchFilter); setRemoveBatchModalOpen(true); }}
              title="Delete every question tagged with this batch"
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-900 hover:text-white transition-all cursor-pointer shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" /> Remove This Batch
            </button>
          )}
        </div>
      )}

      {lastBulkSnapshot && !isAuditor && (
        <div className="mb-6 bg-amber-50 border border-amber-300/60 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 select-none">
          <div className="flex items-center gap-2 text-xs text-amber-800">
            <History className="w-4 h-4 shrink-0" />
            <span>
              Last New Batch bulk action: <span className="font-bold">{lastBulkSnapshot.action_type.replace(BULK_PREFIX, '').replace('_', ' ')}</span> by{' '}
              <span className="font-bold">{lastBulkSnapshot.performed_by_name || 'someone'}</span> on{' '}
              {lastBulkSnapshot.snapshot.length} question(s), {new Date(lastBulkSnapshot.created_at).toLocaleString()}.
            </span>
          </div>
          <button
            onClick={handleUndoLastBulkAction}
            disabled={isUndoingBulk}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-amber-400 bg-white text-amber-700 hover:bg-amber-900 hover:text-white transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Undo2 className="w-3.5 h-3.5" /> {isUndoingBulk ? 'Undoing…' : 'Undo Last Bulk Action'}
          </button>
        </div>
      )}

      {selectedIds.size > 0 && !isAuditor && (
        <div className="mb-6 bg-[#fafafa] border border-[#6366f1]/40 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 select-none">
          <span className="text-xs font-bold text-zinc-600">{selectedIds.size} question(s) selected</span>
          <div className="flex items-center gap-2">
            <button onClick={handleApproveSelected} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-600 hover:bg-emerald-900 hover:text-white transition-all cursor-pointer">
              <Check className="w-3.5 h-3.5" /> Approve Selected
            </button>
            <button onClick={handleRejectSelected} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-900 hover:text-white transition-all cursor-pointer">
              <X className="w-3.5 h-3.5" /> Reject Selected
            </button>
            <button onClick={handleClearSelection} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#e4e4e7] text-zinc-500 hover:text-zinc-900 hover:bg-[#f2f2f3] transition-all cursor-pointer">
              Clear Selection
            </button>
          </div>
        </div>
      )}

      {stats.total > 0 && (
        <div className="mb-6 bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-4 select-none">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-bold text-zinc-600 uppercase tracking-wide">New Batch Review Progress</span>
            <span className="font-mono text-xs font-bold text-zinc-500">{reviewedCount} of {stats.total} reviewed ({reviewProgressPct}%)</span>
          </div>
          <div className="w-full h-2.5 bg-[#f2f2f3] rounded-full overflow-hidden border border-[#e4e4e7]">
            <div className="h-full bg-[#6366f1] transition-all duration-500 ease-out" style={{ width: `${reviewProgressPct}%` }} />
          </div>
        </div>
      )}

      <div className="flex justify-between items-center mb-4.5 select-none">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold tracking-tight text-zinc-600 uppercase">New Batch Items</h3>
          <span className="font-mono text-[12px] font-bold text-zinc-500 bg-[#fafafa] border border-[#e4e4e7] px-2.5 py-0.5 rounded-full">
            Showing {paginatedQuestions.length ? (pageSafe - 1) * pageSize + 1 : 0}–{(pageSafe - 1) * pageSize + paginatedQuestions.length} of {filteredQuestions.length} filtered ({questions.length} total)
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!isAuditor && (
            <>
              <button
                onClick={handleSelectAllVisible}
                disabled={filteredQuestions.length === 0}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${filteredQuestions.length === 0 ? 'text-zinc-600 border-[#e4e4e7] bg-[#fafafa] cursor-not-allowed' : 'text-zinc-600 border-[#e4e4e7] hover:text-zinc-900 hover:bg-[#f2f2f3]'}`}
              >
                Select All Visible
              </button>
              <button
                onClick={handleApproveAllFiltered}
                disabled={filteredQuestions.length === 0}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${filteredQuestions.length === 0 ? 'text-zinc-600 border-[#e4e4e7] bg-[#fafafa] cursor-not-allowed' : 'text-emerald-600 border-emerald-200 bg-emerald-50 hover:bg-emerald-900 hover:text-white'}`}
              >
                <Check className="w-3.5 h-3.5" /> Approve All Filtered ({filteredQuestions.length})
              </button>
              <button
                onClick={handleRejectAllFiltered}
                disabled={filteredQuestions.length === 0}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${filteredQuestions.length === 0 ? 'text-zinc-600 border-[#e4e4e7] bg-[#fafafa] cursor-not-allowed' : 'text-rose-600 border-rose-200 bg-rose-50 hover:bg-rose-900 hover:text-white'}`}
              >
                <X className="w-3.5 h-3.5" /> Reject All Filtered ({filteredQuestions.length})
              </button>
            </>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <AnimatePresence mode="popLayout">
          {!loaded ? (
            <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-12 text-center text-xs text-zinc-500">Loading New Batch workspace…</div>
          ) : questions.length === 0 ? (
            <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-12 text-center flex flex-col items-center justify-center shadow-xs">
              <div className="w-12 h-12 rounded-full bg-[#f2f2f3] border border-[#e4e4e7] flex items-center justify-center text-[#4f46e5] mb-3.5">
                <Upload className="w-5 h-5 animate-pulse" />
              </div>
              <h4 className="text-sm font-bold text-zinc-900">No questions loaded in the New Batch workspace yet</h4>
              <p className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto leading-relaxed">
                {isAdmin
                  ? <>Drag and drop a new batch JSON file onto the panel above, or use the <span className="text-zinc-600 font-semibold">Upload New Batch JSON</span> button.</>
                  : 'Ask an admin to upload a new batch of questions to begin reviewing here.'}
              </p>
            </motion.div>
          ) : paginatedQuestions.length === 0 ? (
            <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-12 text-center flex flex-col items-center justify-center shadow-xs">
              <div className="w-12 h-12 rounded-full bg-[#f2f2f3] border border-[#e4e4e7] flex items-center justify-center text-zinc-500 mb-3.5">
                <Info className="w-5 h-5" />
              </div>
              <h4 className="text-sm font-bold text-zinc-900">No questions match your filter query</h4>
              <button onClick={handleResetFilters} className="mt-4 px-4 py-2 bg-[#6366f1] text-white text-xs font-bold rounded-lg hover:bg-indigo-700 transition-all cursor-pointer border border-[#6366f1]">
                Clear Active Filters
              </button>
            </motion.div>
          ) : (
            paginatedQuestions.map((question, idx) => (
              <QuestionCard
                key={question.id}
                question={question}
                hasNext={idx < paginatedQuestions.length - 1}
                onNext={() => {
                  const next = paginatedQuestions[idx + 1];
                  if (next) document.getElementById(`question-${next.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                onApprove={handleApprove}
                onReject={handleReject}
                onResetStatus={handleResetStatus}
                onEdit={handleEditTrigger}
                isSelected={selectedIds.has(question.id)}
                onToggleSelect={handleToggleSelect}
                onAddComment={handleAddComment}
                onViewDuplicate={handleViewDuplicate}
                onSetCheck={handleSetCheck}
                onCategoryOverride={handleCategoryOverride}
                onDifficultyOverride={handleDifficultyOverride}
                onManualOverride={handleManualOverride}
                onClearOverride={handleClearOverride}
                availableCategories={uniqueCategories}
                onClaim={handleClaimQuestion}
                onReleaseClaim={handleReleaseClaim}
                currentUserId={session?.user.id || null}
                isAdmin={isAdmin}
                isAuditor={isAuditor}
                validators={validators}
                onAssign={handleAssignQuestion}
                onSubmitConsensusReview={handleSubmitConsensusReview}
                onResolveConsensus={handleResolveConsensus}
                auditLogs={logsByQuestionId.get(question.id) || EMPTY_AUDIT_LOGS}
                onOpenHistory={(q) => setHistoryDrawerQuestion(q)}
              />
            ))
          )}
        </AnimatePresence>
      </div>

      {filteredQuestions.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 mt-4 px-1">
          <div className="flex items-center gap-2 text-[12px] text-zinc-500">
            <span>Sort by</span>
            <select value={sortField} onChange={(e) => setSortField(e.target.value as SortField)} className="bg-[#fafafa] border border-[#e4e4e7] rounded-md px-2 py-1 text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] cursor-pointer">
              <option value="dateGenerated">Date generated</option>
              <option value="difficulty">Difficulty</option>
              <option value="category">Category</option>
              <option value="id">Question ID</option>
            </select>
            <button onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')} className="px-2 py-1 rounded-md border border-[#e4e4e7] text-zinc-600 hover:bg-[#f2f2f3] cursor-pointer font-bold">
              {sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
            </button>
            <span className="text-zinc-500">|</span>
            <span>Rows per page</span>
            <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }} className="bg-[#fafafa] border border-[#e4e4e7] rounded-md px-2 py-1 text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] cursor-pointer">
              {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={pageSafe <= 1} className="px-2.5 py-1.5 text-[12px] font-bold rounded-md border border-[#e4e4e7] text-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#f2f2f3] cursor-pointer">
              Prev
            </button>
            <span className="text-[12px] text-zinc-500 font-mono px-1">Page {pageSafe} of {totalPages}</span>
            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={pageSafe >= totalPages} className="px-2.5 py-1.5 text-[12px] font-bold rounded-md border border-[#e4e4e7] text-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#f2f2f3] cursor-pointer">
              Next
            </button>
          </div>
        </div>
      )}

      <EditModal isOpen={isEditModalOpen} question={selectedEditQuestion} onClose={() => { setIsEditModalOpen(false); setSelectedEditQuestion(null); }} onSave={handleSaveEditedQuestion} />

      <DuplicateCompareModal
        isOpen={!!duplicateCompareQuestion}
        flaggedQuestion={duplicateCompareQuestion}
        matchedQuestion={duplicateCompareQuestion?.similar_question_id ? questions.find(q => q.id === duplicateCompareQuestion.similar_question_id) : null}
        onClose={() => setDuplicateCompareQuestion(null)}
      />

      <QuestionHistoryDrawer
        isOpen={!!historyDrawerQuestion}
        question={historyDrawerQuestion}
        isAdmin={isAdmin}
        onClose={() => setHistoryDrawerQuestion(null)}
        onRestore={handleRestoreQuestionSnapshot}
      />

      {/* Bulk confirm modal */}
      <AnimatePresence>
        {bulkConfirm && (() => {
          const isApprove = bulkConfirm.status === 'approved';
          const needsTypedConfirm = bulkConfirm.ids.length > BULK_TYPE_TO_CONFIRM_THRESHOLD;
          const typedConfirmOk = !needsTypedConfirm || bulkConfirmTypedText.trim().toUpperCase() === 'CONFIRM';
          const actionNoun = isApprove ? 'Approve' : 'Reject';
          const scopeLabel = bulkConfirm.actionType === 'approve_filtered' || bulkConfirm.actionType === 'reject_filtered' ? 'currently filtered' : 'manually selected';
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !isSubmittingBulk && setBulkConfirm(null)} className="absolute inset-0 bg-[#000]/90" />
              <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }} className="relative w-full max-w-md bg-[#fafafa] border border-[#e4e4e7] rounded-2xl p-6 shadow-2xl overflow-hidden z-10">
                <div className="flex items-start gap-4">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 border ${isApprove ? 'bg-emerald-50 border-emerald-500/30 text-emerald-600' : 'bg-rose-50 border-rose-500/30 text-rose-500'}`}>
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div className="space-y-1.5 flex-1">
                    <h3 className="text-sm font-bold text-zinc-900 tracking-tight">{actionNoun} {bulkConfirm.ids.length} {scopeLabel} question(s)?</h3>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      This changes review status for {bulkConfirm.ids.length} question(s) in the New Batch pool. A snapshot of their current state is saved first, so this can be undone afterward.
                    </p>
                  </div>
                </div>
                {needsTypedConfirm && (
                  <div className="mt-4">
                    <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wide">Type CONFIRM to proceed ({bulkConfirm.ids.length} is a large batch)</label>
                    <input autoFocus value={bulkConfirmTypedText} onChange={(e) => setBulkConfirmTypedText(e.target.value)} placeholder="CONFIRM" className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-[#e4e4e7] bg-white focus:outline-none focus:ring-2 focus:ring-[#6366f1]/40" />
                  </div>
                )}
                <div className="mt-6 flex items-center justify-end gap-3">
                  <button type="button" disabled={isSubmittingBulk} onClick={() => setBulkConfirm(null)} className="px-4 py-2 text-xs font-bold text-zinc-500 hover:text-zinc-900 bg-[#f2f2f3] hover:bg-[#e8e8e9] border border-[#e4e4e7] rounded-xl transition-all cursor-pointer disabled:opacity-50">
                    Cancel
                  </button>
                  <button type="button" disabled={!typedConfirmOk || isSubmittingBulk} onClick={executeBulkConfirm} className={`px-4 py-2 text-xs font-bold text-white rounded-xl transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${isApprove ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}>
                    {isSubmittingBulk ? 'Working…' : `${actionNoun} ${bulkConfirm.ids.length}`}
                  </button>
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      {/* Clear workspace confirm modal */}
      <AnimatePresence>
        {isClearConfirmOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsClearConfirmOpen(false)} className="absolute inset-0 bg-[#000]/90" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }} className="relative w-full max-w-md bg-[#fafafa] border border-[#e4e4e7] rounded-2xl p-6 shadow-2xl overflow-hidden z-10">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-rose-50 border border-rose-500/30 flex items-center justify-center text-rose-500 shrink-0">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div className="space-y-1.5 flex-1">
                  <h3 className="text-sm font-bold text-zinc-900 tracking-tight">Wipe New Batch Workspace?</h3>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    This clears all {questions.length} questions from the New Batch pool only — the main Curator pool is untouched.
                  </p>
                </div>
              </div>
              <div className="mt-6 flex items-center justify-end gap-3">
                <button type="button" onClick={() => setIsClearConfirmOpen(false)} className="px-4 py-2 text-xs font-bold text-zinc-500 hover:text-zinc-900 bg-[#f2f2f3] hover:bg-[#e8e8e9] border border-[#e4e4e7] rounded-xl transition-all cursor-pointer">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setIsClearConfirmOpen(false);
                    const ok = await deleteAllQuestions();
                    if (ok) {
                      showToast('New Batch workspace cleared.', 'info');
                      logEvent('clear', 'Wiped all questions from the New Batch workspace');
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }
                  }}
                  className="px-4 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 border border-rose-600 rounded-xl transition-all cursor-pointer shadow-sm shadow-rose-950/50"
                >
                  Yes, Wipe New Batch
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Remove Batch confirm modal */}
      <AnimatePresence>
        {removeBatchModalOpen && (() => {
          const group = batchGroups.find(g => g.key === removeBatchKey);
          if (!group) return null;
          const typedOk = removeBatchTypedText.trim().toUpperCase() === 'DELETE';
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !isRemovingBatch && setRemoveBatchModalOpen(false)} className="absolute inset-0 bg-[#000]/90" />
              <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }} className="relative w-full max-w-md bg-[#fafafa] border border-[#e4e4e7] rounded-2xl p-6 shadow-2xl overflow-hidden z-10">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-full bg-rose-50 border border-rose-500/30 flex items-center justify-center text-rose-500 shrink-0">
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div className="space-y-1.5 flex-1">
                    <h3 className="text-sm font-bold text-zinc-900 tracking-tight">Remove batch "{group.label}"?</h3>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      Permanently deletes all {group.count} question(s) tagged with this batch from the New Batch pool — regardless of review status. This does not undo anything already merged into the main Curator pool, and it cannot be undone here.
                    </p>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-zinc-100 text-zinc-600 border border-zinc-200">{group.pending} pending</span>
                      <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">{group.approved} approved</span>
                      <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-rose-50 text-rose-700 border border-rose-200">{group.rejected} rejected</span>
                      <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-amber-50 text-amber-700 border border-amber-200">{group.needsRevision} needs revision</span>
                    </div>
                  </div>
                </div>
                <div className="mt-4">
                  <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wide">Type DELETE to confirm</label>
                  <input autoFocus value={removeBatchTypedText} onChange={(e) => setRemoveBatchTypedText(e.target.value)} placeholder="DELETE" className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-[#e4e4e7] bg-white focus:outline-none focus:ring-2 focus:ring-rose-500/40" />
                </div>
                <div className="mt-6 flex items-center justify-end gap-3">
                  <button type="button" disabled={isRemovingBatch} onClick={() => { setRemoveBatchModalOpen(false); setRemoveBatchTypedText(''); }} className="px-4 py-2 text-xs font-bold text-zinc-500 hover:text-zinc-900 bg-[#f2f2f3] hover:bg-[#e8e8e9] border border-[#e4e4e7] rounded-xl transition-all cursor-pointer disabled:opacity-50">
                    Cancel
                  </button>
                  <button type="button" disabled={!typedOk || isRemovingBatch} onClick={() => removeBatch(group.key)} className="px-4 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 border border-rose-600 rounded-xl transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                    {isRemovingBatch ? 'Removing…' : `Remove ${group.count} Question(s)`}
                  </button>
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      {/* Merge into Curator modal */}
      <AnimatePresence>
        {mergeModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !isMerging && setMergeModalOpen(false)} className="absolute inset-0 bg-[#000]/90" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }} className="relative w-full max-w-md bg-[#fafafa] border border-[#e4e4e7] rounded-2xl p-6 shadow-2xl overflow-hidden z-10">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-indigo-50 border border-indigo-500/30 flex items-center justify-center text-[#4f46e5] shrink-0">
                  <GitMerge className="w-5 h-5" />
                </div>
                <div className="space-y-1.5 flex-1">
                  <h3 className="text-sm font-bold text-zinc-900 tracking-tight">Merge New Batch into Curator</h3>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    Copies the chosen items from this isolated New Batch pool into the main <span className="font-mono">questions</span> table (upserted by id). Nothing is removed from New Batch, and nothing moves unless you confirm here.
                  </p>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {([
                  { value: 'approved', label: `Approved only (${questions.filter(q => q.reviewStatus === 'approved').length})` },
                  { value: 'selected', label: `Manually selected (${selectedIds.size})` },
                  { value: 'all', label: `Everything in New Batch (${questions.length})` }
                ] as { value: 'approved' | 'selected' | 'all'; label: string }[]).map(opt => (
                  <label key={opt.value} className="flex items-center gap-2 text-xs font-semibold text-zinc-700 cursor-pointer px-3 py-2 rounded-lg border border-[#e4e4e7] bg-white hover:bg-[#f2f2f3]">
                    <input type="radio" name="mergeScope" checked={mergeScope === opt.value} onChange={() => setMergeScope(opt.value)} />
                    {opt.label}
                  </label>
                ))}
              </div>

              <div className="mt-6 flex items-center justify-end gap-3">
                <button type="button" disabled={isMerging} onClick={() => setMergeModalOpen(false)} className="px-4 py-2 text-xs font-bold text-zinc-500 hover:text-zinc-900 bg-[#f2f2f3] hover:bg-[#e8e8e9] border border-[#e4e4e7] rounded-xl transition-all cursor-pointer disabled:opacity-50">
                  Cancel
                </button>
                <button type="button" disabled={isMerging} onClick={runMerge} className="px-4 py-2 text-xs font-bold text-white bg-[#6366f1] hover:bg-indigo-700 border border-[#6366f1] rounded-xl transition-all cursor-pointer disabled:opacity-50">
                  {isMerging ? 'Merging…' : 'Merge Now'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}