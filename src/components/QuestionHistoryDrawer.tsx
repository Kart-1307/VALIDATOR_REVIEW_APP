import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, History, RotateCcw, ShieldCheck, Loader2, AlertCircle } from 'lucide-react';
import { SATQuestion, QuestionSnapshot } from '../types';
import { supabase } from '../lib/supabaseClient';

interface QuestionHistoryDrawerProps {
  isOpen: boolean;
  question: SATQuestion | null;
  isAdmin: boolean;
  onClose: () => void;
  // Returns true on success so the drawer knows to refresh its list.
  onRestore: (snapshot: QuestionSnapshot) => Promise<boolean>;
}

const ACTION_TYPE_LABELS: Record<string, string> = {
  approve: 'Approved',
  reject: 'Rejected',
  check: 'Rubric checklist changed',
  category_override: 'Category reassigned',
  difficulty_override: 'Difficulty reassigned',
  manual_override: 'Manual status override applied',
  clear_override: 'Manual status override cleared',
  reset: 'Reset to Pending',
  resolve_consensus: 'Primary vs. second-opinion resolved'
};

function formatActionType(actionType: string) {
  return ACTION_TYPE_LABELS[actionType] || actionType.replace(/_/g, ' ');
}

function statusBadgeClasses(status?: string) {
  switch (status) {
    case 'approved':
      return 'bg-emerald-50 text-emerald-600 border-emerald-200';
    case 'rejected':
      return 'bg-rose-50 text-rose-600 border-rose-200';
    case 'needs_revision':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    default:
      return 'bg-[#ececed] text-zinc-500 border-[#e4e4e7]';
  }
}

// Small read-only summary of what a snapshot's saved state looked like, so
// an admin can tell entries apart at a glance without having to open the
// full question — the review status, the 4 rubric checks, and category/
// difficulty at that point in time.
function SnapshotStatePreview({ snapshot }: { snapshot: SATQuestion }) {
  const checks: { label: string; value: boolean | null | undefined }[] = [
    { label: 'Formation', value: snapshot.formationOk },
    { label: 'Answer', value: snapshot.answerOk },
    { label: 'Category', value: snapshot.categoryOk },
    { label: 'Difficulty', value: snapshot.difficultyOk }
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border capitalize ${statusBadgeClasses(snapshot.reviewStatus)}`}>
        {(snapshot.reviewStatus || 'pending').replace('_', ' ')}
      </span>
      {checks.map(c => (
        <span
          key={c.label}
          title={`${c.label}: ${c.value === true ? 'Yes' : c.value === false ? 'No' : 'Unanswered'}`}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
            c.value === true
              ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
              : c.value === false
              ? 'bg-rose-50 text-rose-600 border-rose-200'
              : 'bg-[#f2f2f3] text-zinc-500 border-[#e4e4e7]'
          }`}
        >
          {c.label[0]}
        </span>
      ))}
      <span className="text-[11px] text-zinc-500 font-mono">{snapshot.category}</span>
      <span className="text-[11px] text-zinc-500 font-mono capitalize">{snapshot.difficulty}</span>
    </div>
  );
}

export default function QuestionHistoryDrawer({ isOpen, question, isAdmin, onClose, onRestore }: QuestionHistoryDrawerProps) {
  const [snapshots, setSnapshots] = useState<QuestionSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadSnapshots = async (questionId: string) => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await supabase
      .from('question_snapshots')
      .select('*')
      .eq('question_id', questionId)
      .order('created_at', { ascending: false });
    if (error) {
      setLoadError(error.message);
      setSnapshots([]);
    } else {
      setSnapshots((data || []) as QuestionSnapshot[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (isOpen && question) {
      loadSnapshots(question.id);
    } else {
      setSnapshots([]);
      setLoadError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, question?.id]);

  const handleRestoreClick = async (snap: QuestionSnapshot) => {
    if (!question) return;
    setRestoringId(snap.id);
    const success = await onRestore(snap);
    setRestoringId(null);
    if (success) {
      loadSnapshots(question.id);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && question && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-[#000]/90"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 10 }}
            className="relative w-full max-w-2xl bg-[#fafafa] border border-[#e4e4e7] rounded-2xl shadow-2xl overflow-hidden z-10"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3]">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-indigo-600" />
                <div>
                  <h3 className="text-sm font-bold text-zinc-900 tracking-tight">Revert History</h3>
                  <p className="text-[12px] text-zinc-500 font-mono">{question.id}</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-[#e4e4e7] rounded-lg transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {!isAdmin && (
              <div className="mx-5 mt-4 flex items-start gap-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Only admins can restore a question to a past state. You can still view the timeline below.</span>
              </div>
            )}

            <div className="p-5 flex flex-col gap-2.5 max-h-[60vh] overflow-y-auto">
              {loading && (
                <div className="flex items-center justify-center gap-2 text-xs text-zinc-500 py-8">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading history…
                </div>
              )}

              {!loading && loadError && (
                <div className="flex items-center gap-2 text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-3">
                  <AlertCircle className="w-4 h-4 shrink-0" /> Failed to load history: {loadError}
                </div>
              )}

              {!loading && !loadError && snapshots.length === 0 && (
                <p className="text-[12px] text-zinc-500 italic text-center py-8 bg-white rounded-lg border border-[#e4e4e7]">
                  No prior actions recorded for this item yet — history starts accumulating the next time
                  someone approves, rejects, toggles a check, or overrides it.
                </p>
              )}

              {!loading && !loadError && snapshots.map(snap => (
                <div key={snap.id} className="bg-white border border-[#e4e4e7] rounded-xl p-3.5 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <p className="text-[13px] font-bold text-zinc-900">{formatActionType(snap.action_type)}</p>
                      <p className="text-[11px] text-zinc-500 font-mono">
                        {new Date(snap.created_at).toLocaleString()} · by {snap.performed_by_name || 'unknown'}
                      </p>
                    </div>
                    {snap.restored && (
                      <span className="flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-200 shrink-0">
                        <ShieldCheck className="w-3 h-3" /> Restored before
                      </span>
                    )}
                  </div>

                  <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wide">State at this point:</p>
                  <SnapshotStatePreview snapshot={snap.snapshot} />

                  {isAdmin && (
                    <div className="flex justify-end pt-1">
                      <button
                        onClick={() => handleRestoreClick(snap)}
                        disabled={restoringId === snap.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-600 hover:text-white transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {restoringId === snap.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="w-3.5 h-3.5" />
                        )}
                        Restore this version
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="px-5 pb-5">
              <p className="text-[12px] text-zinc-500 leading-relaxed">
                Restoring puts this question back to exactly what it looked like right before that action ran.
                It doesn't erase any other entry in this timeline, so if a restore turns out wrong, you can
                always pick a different point above and try again.
              </p>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
