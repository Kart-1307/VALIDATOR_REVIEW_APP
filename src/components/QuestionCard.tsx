import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { Check, X, Edit3, HelpCircle, ChevronDown, ChevronUp, AlertCircle, RefreshCw, MessageSquare, Copy, ShieldCheck, ShieldAlert, Settings2, Lock, Unlock, History, Calculator, Sparkles, ClipboardCopy, CheckCircle2 } from 'lucide-react';
import { SATQuestion, MAX_CONSENSUS_REVIEWERS } from '../types';
import { getConsensusResolution } from '../lib/consensus';
import DesmosModal from './DesmosModal';
import { isMathQuestion, extractExpressions, buildDesmosSolution, analyzeDistractors, suggestDistractors } from '../lib/mathTools';

interface QuestionCardProps {
  key?: string | number;
  question: SATQuestion;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onResetStatus: (id: string) => void;
  onEdit: (question: SATQuestion) => void;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  // Spec §6: append a threaded, timestamped, attributed comment to this question
  onAddComment: (id: string, text: string) => void;
  // Point 6: side-by-side duplicate view — open the compare modal for this item
  onViewDuplicate: (question: SATQuestion) => void;
  // --- Validation Actions (spec §5): 4 independent Yes/No checks + reassignment + override ---
  onSetCheck: (id: string, updates: Partial<Record<'formationOk' | 'answerOk' | 'categoryOk' | 'difficultyOk', boolean | null>>) => void;
  onCategoryOverride: (id: string, newCategory: string) => void;
  onDifficultyOverride: (id: string, newDifficulty: 'easy' | 'medium' | 'hard') => void;
  onManualOverride: (id: string, status: 'approved' | 'rejected' | 'needs_revision', justification: string) => void;
  onClearOverride: (id: string) => void;
  availableCategories: string[];
  // Claim/lock (spec §3, §7)
  onClaim: (id: string) => void;
  onReleaseClaim: (id: string) => void;
  currentUserId: string | null;
  // Admin-assigned queue (spec §3) + consensus review (spec §7)
  isAdmin: boolean;
  // Read-only/Auditor role (spec §2): can view everything, cannot write anything
  isAuditor?: boolean;
  validators: { id: string; name: string; email: string }[];
  onAssign: (id: string, validatorId: string | null) => void;
  onSubmitConsensusReview: (id: string, checks: { formationOk: boolean | null; answerOk: boolean | null; categoryOk: boolean | null; difficultyOk: boolean | null }) => void;
  // Admin-only: resolve a primary-reviewer vs. second-opinion disagreement
  onResolveConsensus?: (id: string, resolution: 'primary' | 'second_opinion') => void;
  // Audit log list (spec §8)
  auditLogs?: {
    id: string;
    timestamp: string;
    action: string;
    description: string;
    user?: string;
  }[];
  // Jump to the next card in the current (filtered/sorted/paginated) list once
  // this one's been reviewed. Omitted/false on the last card in the list.
  onNext?: () => void;
  hasNext?: boolean;
}

export default function QuestionCard({
  question,
  onApprove,
  onReject,
  onResetStatus,
  onEdit,
  isSelected,
  onToggleSelect,
  onAddComment,
  onViewDuplicate,
  onSetCheck,
  onCategoryOverride,
  onDifficultyOverride,
  onManualOverride,
  onClearOverride,
  availableCategories,
  onClaim,
  onReleaseClaim,
  currentUserId,
  isAdmin,
  isAuditor = false,
  validators,
  onAssign,
  onSubmitConsensusReview,
  onResolveConsensus,
  auditLogs = [],
  onNext,
  hasNext = false
}: QuestionCardProps) {
  const [isExpOpen, setIsExpOpen] = useState(true);
  const [newCommentDraft, setNewCommentDraft] = useState('');
  const [isAuditOpen, setIsAuditOpen] = useState(false);

  // --- Enhancement §1/§2/§3: Math-only tools (Desmos calculator, Desmos-style
  // step-by-step solution, distractor quality assistant) ---
  const [isDesmosOpen, setIsDesmosOpen] = useState(false);
  const [isDesmosSolutionOpen, setIsDesmosSolutionOpen] = useState(false);
  const [isDistractorPanelOpen, setIsDistractorPanelOpen] = useState(false);
  const [copiedDistractor, setCopiedDistractor] = useState<string | null>(null);
  const isMath = isMathQuestion(question);
  const mathExpressions = isMath ? extractExpressions(question) : [];
  const [consensusDraft, setConsensusDraft] = useState<{ formationOk: boolean | null; answerOk: boolean | null; categoryOk: boolean | null; difficultyOk: boolean | null }>({
    formationOk: null, answerOk: null, categoryOk: null, difficultyOk: null
  });

  // --- Required comment when a check fails (spec §6) ---
  // Clicking "No" on any of the 4 checks doesn't immediately record the fail —
  // it opens this inline required-comment prompt first. The check only flips
  // to No once a non-empty comment is submitted alongside it.
  const [pendingFailures, setPendingFailures] = useState<Record<string, string>>({});
  const [failureCommentDraft, setFailureCommentDraft] = useState('');

  const requestFail = (field: 'formationOk' | 'answerOk' | 'categoryOk' | 'difficultyOk', label: string) => {
    setPendingFailures(prev => ({ ...prev, [field]: label }));
    setFailureCommentDraft('');
  };

  const confirmFailure = () => {
    if (Object.keys(pendingFailures).length === 0 || !failureCommentDraft.trim()) return;
    const labels = Object.values(pendingFailures).join(', ');
    onAddComment(question.id, `[${labels} marked incorrect] ${failureCommentDraft.trim()}`);
    
    const updates: Partial<Record<'formationOk' | 'answerOk' | 'categoryOk' | 'difficultyOk', boolean>> = {};
    Object.keys(pendingFailures).forEach(field => {
      updates[field as 'formationOk' | 'answerOk' | 'categoryOk' | 'difficultyOk'] = false;
    });
    onSetCheck(question.id, updates);
    
    setPendingFailures({});
    setFailureCommentDraft('');
  };

  // --- Validation Actions local UI state ---
  const defaultCategories = [
    'Craft and Structure',
    'Information and Ideas',
    'Expression of Ideas',
    'Standard English Conventions',
    'Algebra',
    'Advanced Math',
    'Problem-Solving and Data Analysis',
    'Geometry and Trigonometry'
  ];
  const allCategories = Array.from(new Set([...defaultCategories, ...(availableCategories || [])])).sort();

  const [categoryDraft, setCategoryDraft] = useState(question.category);
  const [difficultyDraft, setDifficultyDraft] = useState<'easy' | 'medium' | 'hard'>(
    (question.difficulty as 'easy' | 'medium' | 'hard') || 'medium'
  );

  // Synchronize local edit state with incoming props as the user steps through items in the queue
  useEffect(() => {
    setCategoryDraft(question.category);
    setDifficultyDraft((question.difficulty as 'easy' | 'medium' | 'hard') || 'medium');
  }, [question.id, question.category, question.difficulty]);

  // Keep track of the previous check values to detect external transition to true
  const prevChecksRef = useRef({
    id: question.id,
    formationOk: question.formationOk,
    answerOk: question.answerOk,
    categoryOk: question.categoryOk,
    difficultyOk: question.difficultyOk
  });

  useEffect(() => {
    const prevChecks = prevChecksRef.current;
    if (question.id !== prevChecks.id) {
      // If the question changed, reset pending failure states
      setPendingFailures({});
      setFailureCommentDraft('');
    } else {
      let changed = false;
      const next = { ...pendingFailures };

      // Clear pending failure only if a check transitioned from not-true to true (e.g. externally updated)
      if (question.formationOk && !prevChecks.formationOk && next.formationOk) {
        delete next.formationOk;
        changed = true;
      }
      if (question.answerOk && !prevChecks.answerOk && next.answerOk) {
        delete next.answerOk;
        changed = true;
      }
      if (question.categoryOk && !prevChecks.categoryOk && next.categoryOk) {
        delete next.categoryOk;
        changed = true;
      }
      if (question.difficultyOk && !prevChecks.difficultyOk && next.difficultyOk) {
        delete next.difficultyOk;
        changed = true;
      }

      if (changed) {
        setPendingFailures(next);
        if (Object.keys(next).length === 0) {
          setFailureCommentDraft('');
        }
      }
    }

    // Sync ref
    prevChecksRef.current = {
      id: question.id,
      formationOk: question.formationOk,
      answerOk: question.answerOk,
      categoryOk: question.categoryOk,
      difficultyOk: question.difficultyOk
    };
  }, [
    question.id,
    question.formationOk,
    question.answerOk,
    question.categoryOk,
    question.difficultyOk,
    pendingFailures
  ]);

  const handleYes = (field: 'formationOk' | 'answerOk' | 'categoryOk' | 'difficultyOk') => {
    if (pendingFailures[field]) {
      setPendingFailures(prev => {
        const next = { ...prev };
        delete next[field];
        if (Object.keys(next).length === 0) {
          setFailureCommentDraft('');
        }
        return next;
      });
    }
    onSetCheck(question.id, { [field]: true });
  };

  // Bug fix (no way to undo a check): clicking Yes/No always set true/staged-false
  // with no path back to "unanswered." This clears a persisted check back to null,
  // and/or cancels a staged (not-yet-confirmed) "No" if one is pending.
  const handleReset = (field: 'formationOk' | 'answerOk' | 'categoryOk' | 'difficultyOk') => {
    if (pendingFailures[field]) {
      setPendingFailures(prev => {
        const next = { ...prev };
        delete next[field];
        if (Object.keys(next).length === 0) {
          setFailureCommentDraft('');
        }
        return next;
      });
    }
    onSetCheck(question.id, { [field]: null });
  };

  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideStatusDraft, setOverrideStatusDraft] = useState<'approved' | 'rejected' | 'needs_revision'>('needs_revision');
  const [overrideJustificationDraft, setOverrideJustificationDraft] = useState('');

  // Status-specific styles
  const isApproved = question.reviewStatus === 'approved';
  const isRejected = question.reviewStatus === 'rejected';
  const isNeedsRevision = question.reviewStatus === 'needs_revision';
  const isPending = !question.reviewStatus || question.reviewStatus === 'pending';

  // --- Claim/lock (spec §3, §7) ---
  const isClaimed = !!question.claimedBy;
  const isClaimedByMe = isClaimed && question.claimedBy === currentUserId;
  const isLockedByOther = isClaimed && !isClaimedByMe;

  let borderStyle = 'border-[#e4e4e7]';
  let cardBg = 'bg-[#fafafa]';
  let badgeColor = 'bg-[#ececed] text-zinc-600 border border-[#e4e4e7]';

  if (isApproved) {
    borderStyle = 'border-emerald-500/50 ring-1 ring-emerald-500/10';
    cardBg = 'bg-[#fafafa]';
    badgeColor = 'bg-emerald-50 text-emerald-600 border border-emerald-200';
  } else if (isRejected) {
    borderStyle = 'border-[#e4e4e7] opacity-50';
    cardBg = 'bg-white';
    badgeColor = 'bg-[#f2f2f3] text-zinc-500 border border-[#e4e4e7]';
  } else if (isNeedsRevision) {
    borderStyle = 'border-orange-500/50 ring-1 ring-orange-500/10';
    cardBg = 'bg-[#fafafa]';
    badgeColor = 'bg-orange-50 text-orange-600 border border-orange-200';
  }

  // Three-state check pill helper — value is boolean|null|undefined
  const CheckToggle = ({
    value,
    onYes,
    onNo,
    onReset,
    isPendingNo
  }: { value: boolean | null | undefined; onYes: () => void; onNo: () => void; onReset?: () => void; isPendingNo?: boolean }) => (
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        onClick={() => (value === true && !isPendingNo && onReset ? onReset() : onYes())}
        disabled={isAuditor}
        title={isAuditor ? 'Auditors have read-only access' : (value === true && !isPendingNo && onReset ? 'Click to undo' : 'Mark as correct')}
        className={`px-2.5 py-1 text-[12px] font-bold rounded-md border transition-all ${isAuditor ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${value === true && !isPendingNo
            ? 'bg-emerald-600 text-white border-emerald-600'
            : 'text-zinc-500 border-[#e4e4e7] bg-white hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200'
          }`}
      >
        Yes
      </button>
      <button
        onClick={() => ((value === false || isPendingNo) && onReset ? onReset() : onNo())}
        disabled={isAuditor}
        title={isAuditor ? 'Auditors have read-only access' : ((value === false || isPendingNo) && onReset ? 'Click to undo' : 'Mark as incorrect')}
        className={`px-2.5 py-1 text-[12px] font-bold rounded-md border transition-all ${isAuditor ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${value === false || isPendingNo
            ? 'bg-rose-600 text-white border-rose-600'
            : 'text-zinc-500 border-[#e4e4e7] bg-white hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200'
          }`}
      >
        No
      </button>
    </div>
  );

  // Formatting helper
  const getDifficultyBadge = (diff: string) => {
    switch (diff?.toLowerCase()) {
      case 'easy':
        return 'bg-blue-50 text-blue-600 border border-blue-200';
      case 'medium':
        return 'bg-amber-50 text-amber-700 border border-amber-200';
      case 'hard':
        return 'bg-rose-50 text-rose-600 border border-rose-200';
      default:
        return 'bg-[#ececed] text-zinc-500 border border-[#e4e4e7]';
    }
  };

  const getSectionLabel = (sect?: string, section?: string) => {
    const s = sect || section || '';
    if (s.toLowerCase().includes('reading')) return 'Reading & Writing';
    if (s.toLowerCase().includes('math')) return 'Mathematics';
    return s || 'General';
  };

  return (
    <motion.div
      id={`question-${question.id}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={`rounded-xl border shadow-sm p-6 transition-all ${borderStyle} ${cardBg} flex flex-col gap-4 relative overflow-hidden`}
    >
      {/* Decorative top pill badge on active selection */}
      {isApproved && (
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-emerald-500" />
      )}
      {isRejected && (
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-zinc-600" />
      )}
      {isNeedsRevision && (
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-orange-500" />
      )}

      {/* Header Info */}
      <div className="flex flex-wrap justify-between items-start gap-2.5 pb-3 border-b border-[#e4e4e7]">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleSelect(question.id)}
            disabled={isAuditor}
            title={isAuditor ? 'Auditors have read-only access' : 'Select this question for bulk action'}
            className="w-4 h-4 rounded border-[#e4e4e7] bg-[#f2f2f3] accent-[#6366f1] cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          />
          <span className="font-mono text-xs font-bold text-zinc-500 select-all tracking-wider">
            {question.id}
          </span>
          <span className="text-zinc-500">|</span>
          <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-[#ececed] text-zinc-600 border border-[#e4e4e7]">
            {getSectionLabel(question.Section, question.section)}
          </span>
          <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${getDifficultyBadge(question.difficulty)}`}>
            {question.difficulty.toUpperCase()}
          </span>
          <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-[#f2f2f3] text-zinc-500 border border-[#e4e4e7]">
            {question.category}
          </span>
          {question.subSkill && (
            <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-[#f2f2f3] text-zinc-500 border border-[#e4e4e7]">
              {question.subSkill}
            </span>
          )}
          {/* Question type (spec §4: MCQ, grid-in, etc.) */}
          <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-[#f2f2f3] text-zinc-500 border border-[#e4e4e7] uppercase tracking-wide">
            {question.questionType === 'grid_in' ? 'Grid-In' : 'MCQ'}
          </span>
        </div>

        {/* Current status display badge */}
        <div className="flex items-center gap-2">
          {isApproved && (
            <span className="text-xs font-bold px-2.5 py-1 rounded-md bg-emerald-600 text-white flex items-center gap-1 shadow-sm shadow-emerald-600/10">
              <Check className="w-3 h-3 stroke-[3]" /> APPROVED
            </span>
          )}
          {isRejected && (
            <span className="text-xs font-bold px-2.5 py-1 rounded-md bg-[#e4e4e7] text-zinc-500 flex items-center gap-1 shadow-sm border border-[#d4d4d8]">
              <X className="w-3 h-3 stroke-[3]" /> REJECTED
            </span>
          )}
          {isNeedsRevision && (
            <span className="text-xs font-bold px-2.5 py-1 rounded-md bg-orange-600 text-white flex items-center gap-1 shadow-sm shadow-orange-600/10">
              <ShieldAlert className="w-3 h-3 stroke-[3]" /> NEEDS REVISION
            </span>
          )}
          {question.statusOverride && (
            <span
              title={question.statusOverrideJustification}
              className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-[#ececed] text-sky-600 border border-sky-200 flex items-center gap-1"
            >
              <Settings2 className="w-3 h-3" /> MANUAL OVERRIDE
            </span>
          )}
          {isPending && (
            <span className="text-xs font-semibold px-2.5 py-1 rounded-md bg-[#ececed] text-zinc-500 border border-[#e4e4e7] flex items-center gap-1 select-none">
              PENDING
            </span>
          )}
        </div>
      </div>

      {/* Claim/lock bar (spec §3, §7): prevents two validators reviewing the same item at once */}
      <div className={`flex items-center justify-between gap-2 -mt-1 -mb-1 px-3 py-2 rounded-lg border text-xs ${isLockedByOther
          ? 'bg-amber-50 border-amber-200 text-amber-700'
          : isClaimedByMe
            ? 'bg-sky-50 border-sky-200 text-sky-600'
            : 'bg-[#fafafa] border-[#e4e4e7] text-zinc-500'
        }`}>
        <span className="flex items-center gap-1.5 font-medium">
          {isLockedByOther ? (
            <><Lock className="w-3.5 h-3.5" /> Claimed by {question.claimedByName || 'another validator'} — review is locked to avoid duplicate work</>
          ) : isClaimedByMe ? (
            <><Unlock className="w-3.5 h-3.5" /> You've claimed this item for review</>
          ) : (
            <><Unlock className="w-3.5 h-3.5" /> Unclaimed — anyone can claim this to start reviewing</>
          )}
        </span>
        {isAuditor ? null : isLockedByOther ? null : isClaimedByMe ? (
          <button
            onClick={() => onReleaseClaim(question.id)}
            className="px-2.5 py-1 text-[12px] font-bold rounded-md border border-sky-200 text-sky-600 hover:bg-sky-900 hover:text-zinc-900 transition-all cursor-pointer shrink-0"
          >
            Release Claim
          </button>
        ) : (
          <button
            onClick={() => onClaim(question.id)}
            className="px-2.5 py-1 text-[12px] font-bold rounded-md border border-[#e4e4e7] text-zinc-600 hover:bg-[#e4e4e7] transition-all cursor-pointer shrink-0"
          >
            Claim to Review
          </button>
        )}
      </div>

      {/* Admin-assigned queue (spec §3) + double-review sample badge (spec §7) */}
      {(isAdmin || question.assignedToName || question.requiresSecondReview) && (
        <div className="flex flex-wrap items-center gap-2 -mt-1 -mb-1">
          {isAdmin && (
            <div className="flex items-center gap-1.5 text-[12px] text-zinc-500">
              <span>Assign to:</span>
              <select
                value={question.assignedTo || ''}
                onChange={(e) => onAssign(question.id, e.target.value || null)}
                className="bg-[#fafafa] border border-[#e4e4e7] rounded-md px-2 py-1 text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-600 cursor-pointer"
              >
                <option value="">Unassigned</option>
                {validators.map(v => (
                  <option key={v.id} value={v.id}>{v.name || v.email}</option>
                ))}
              </select>
            </div>
          )}
          {!isAdmin && question.assignedToName && (
            <span className="text-[12px] text-zinc-500">Assigned to <span className="text-zinc-600 font-semibold">{question.assignedToName}</span></span>
          )}
          {question.requiresSecondReview && (
            <span className="flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">
              🔁 Double-Review Sample
            </span>
          )}
        </div>
      )}

      {/* SAT Passage (for English modules) */}
      {question.passage && (
        <div className="bg-[#f2f2f3] border-l-4 border-indigo-500 pl-4 py-3.5 pr-2.5 my-1 text-sm text-zinc-600 italic leading-relaxed tracking-wide font-sans rounded-r-lg">
          {question.passage}
        </div>
      )}

      {/* Stimulus (equations, systems, data tables — common on Math items).
          Kept visually distinct from the passage block and rendered with
          whitespace preserved + monospace, since these often contain
          multi-line equations that must not be collapsed onto one line. */}
      {question.stimulus && (
        <div className="bg-[#f2f2f3] border-l-4 border-amber-500 pl-4 py-3.5 pr-2.5 my-1 text-sm text-zinc-700 leading-relaxed font-mono whitespace-pre-wrap rounded-r-lg">
          {question.stimulus}
        </div>
      )}

      {/* Supporting graphic (spec §4: "Any supporting passage/graphic if applicable") */}
      {question.imageUrl && (
        <div className="rounded-lg overflow-hidden border border-[#e4e4e7] bg-white">
          <img
            src={question.imageUrl}
            alt={`Supporting graphic for question ${question.id}`}
            className="max-h-96 w-auto mx-auto object-contain"
          />
        </div>
      )}

      {/* Main Question Text */}
      <div className="text-[15px] font-semibold text-zinc-900 leading-relaxed font-sans">
        {question.question}
      </div>

      {/* Multiple Choices (A, B, C, D) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-1">
        {Object.entries(question.choices).map(([key, value]) => {
          const isCorrect = key === question.correct_answer;

          let optStyle = 'border-[#e4e4e7] bg-[#f2f2f3] hover:bg-[#e4e4e7] text-zinc-600';
          let indicatorStyle = 'bg-[#e4e4e7] text-zinc-500 border-[#d4d4d8]';

          if (isCorrect) {
            optStyle = 'border-emerald-500 bg-[rgba(16,185,129,0.05)] text-emerald-600 font-medium';
            indicatorStyle = 'bg-emerald-600 text-white border-emerald-600';
          }

          return (
            <div
              key={key}
              className={`flex items-start gap-3 p-3.5 rounded-xl border text-sm font-sans transition-all leading-normal ${optStyle}`}
            >
              <span className={`w-5.5 h-5.5 rounded-md flex items-center justify-center text-xs font-bold border shrink-0 ${indicatorStyle}`}>
                {key}
              </span>
              <span className={isCorrect ? "text-emerald-600 font-medium" : "text-zinc-600"}>
                {value}
              </span>
            </div>
          );
        })}
      </div>
      {/* Math-only tools (Enhancement §1/§2/§3): Desmos calculator, Desmos-style
          step-by-step solution, and a distractor-quality assistant. Hidden
          entirely for non-Math questions per spec. */}
      {isMath && (
        <div className="flex flex-wrap items-center gap-2 -mt-1">
          <button
            onClick={() => setIsDesmosOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-900/40 hover:text-white transition-all cursor-pointer"
          >
            <Calculator className="w-3.5 h-3.5" /> Open Desmos Calculator
          </button>
          <button
            onClick={() => setIsDesmosSolutionOpen(!isDesmosSolutionOpen)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-900/40 hover:text-white transition-all cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" /> {isDesmosSolutionOpen ? 'Hide' : 'Show'} Desmos Solution Guide
          </button>
          {!isAuditor && (
            <button
              onClick={() => setIsDistractorPanelOpen(!isDistractorPanelOpen)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#e4e4e7] bg-[#f2f2f3] text-zinc-600 hover:bg-[#e4e4e7] transition-all cursor-pointer"
            >
              <ShieldCheck className="w-3.5 h-3.5" /> {isDistractorPanelOpen ? 'Hide' : 'Check'} Distractor Quality
            </button>
          )}
        </div>
      )}

      {/* Desmos-style step-by-step solution (Enhancement §2) */}
      {isMath && isDesmosSolutionOpen && (() => {
        const solution = buildDesmosSolution(question);
        return (
          <div className="border border-sky-200 rounded-xl overflow-hidden bg-sky-50">
            <div className="px-4 py-2.5 bg-sky-50 border-b border-sky-200 text-xs font-bold text-sky-300 uppercase tracking-wide flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" /> Digital SAT-Style Solution, with Desmos
            </div>
            <div className="p-4 flex flex-col gap-3 text-xs text-zinc-600 leading-relaxed">
              <p className="text-zinc-700">{solution.strategy}</p>
              <div className="flex flex-col gap-2.5">
                {solution.steps.map((step, i) => (
                  <div key={i} className="bg-[#fafafa] border border-[#e4e4e7] rounded-lg p-3">
                    <p className="font-semibold text-zinc-900 mb-1">{step.title}</p>
                    <p className="text-zinc-500 mb-1.5">{step.detail}</p>
                    <p className="flex items-start gap-1.5 text-sky-300 font-mono text-[12px]">
                      <Calculator className="w-3 h-3 mt-0.5 shrink-0" /> {step.desmosAction}
                    </p>
                  </div>
                ))}
              </div>
              <p className="text-zinc-500 italic border-t border-[#e4e4e7] pt-2.5">Summary: {solution.desmosSummary}</p>
            </div>
          </div>
        );
      })()}

      {/* Distractor-quality assistant (Enhancement §3) */}
      {isMath && isDistractorPanelOpen && !isAuditor && (() => {
        const analysis = analyzeDistractors(question);
        const suggestions = suggestDistractors(question);
        const flagged = analysis.filter(a => a.flaw !== 'ok');
        return (
          <div className="border border-[#e4e4e7] rounded-xl overflow-hidden bg-[#f2f2f3]">
            <div className="px-4 py-2.5 bg-[#fafafa] border-b border-[#e4e4e7] text-xs font-bold text-zinc-600 uppercase tracking-wide flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" /> Distractor Quality Check
            </div>
            <div className="p-4 flex flex-col gap-3 text-xs text-zinc-600">
              {flagged.length === 0 ? (
                <p className="text-emerald-600 flex items-center gap-1.5"><Check className="w-3.5 h-3.5" /> No obvious issues detected in the current choices.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {flagged.map(f => (
                    <p key={f.key} className="text-amber-700 flex items-start gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> <span><b>{f.key}:</b> {f.note}</span>
                    </p>
                  ))}
                </div>
              )}

              <div className="border-t border-[#e4e4e7] pt-3">
                <p className="font-semibold text-zinc-900 mb-2">Suggested replacement distractors</p>
                <div className="flex flex-col gap-2">
                  {suggestions.map((s, i) => (
                    <div key={i} className="bg-[#fafafa] border border-[#e4e4e7] rounded-lg p-2.5 flex items-start justify-between gap-2">
                      <div>
                        <p className="text-zinc-700 font-semibold">{s.label}: <span className="font-mono text-sky-600">{s.value}</span></p>
                        <p className="text-zinc-500 mt-0.5">{s.rationale}</p>
                      </div>
                      <button
                        onClick={() => {
                          navigator.clipboard?.writeText(s.value);
                          setCopiedDistractor(s.value + i);
                          setTimeout(() => setCopiedDistractor(null), 1500);
                        }}
                        className="flex items-center gap-1 px-2 py-1 text-[12px] font-semibold rounded-md border border-[#e4e4e7] text-zinc-500 hover:bg-[#e4e4e7] hover:text-zinc-900 transition-all cursor-pointer shrink-0"
                      >
                        <ClipboardCopy className="w-3 h-3" /> {copiedDistractor === s.value + i ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-zinc-600 mt-2">Copy a value, then use Edit to apply it to the relevant choice.</p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Validator Context Panel (Gemini verdict) */}
      {question.validatorStatus && (
        <div className={`rounded-xl border p-4 flex flex-col gap-2 text-xs ${question.validatorStatus === 'approved'
            ? 'border-emerald-200 bg-emerald-50'
            : question.validatorStatus === 'rejected'
              ? 'border-rose-200 bg-rose-50'
              : 'border-amber-200 bg-amber-50'
          }`}>
          <div className="flex items-center justify-between">
            <span className="font-bold uppercase tracking-wide text-zinc-600">Pipeline Verdict</span>
            <span className={`text-[12px] font-extrabold px-2 py-0.5 rounded-md border ${question.validatorStatus === 'approved'
                ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
                : question.validatorStatus === 'rejected'
                  ? 'bg-rose-50 text-rose-600 border-rose-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}>
              {question.validatorStatus.toUpperCase()}
            </span>
          </div>
          {question.validatorFeedback && (
            <p className="text-zinc-500 leading-relaxed">{question.validatorFeedback}</p>
          )}
        </div>
      )}

      {/* Similarity / Duplicate Warning */}
      {typeof question.similarity_score === 'number' && question.similarity_score > 0.85 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex flex-wrap items-center justify-between gap-2.5 text-xs">
          <p className="text-amber-300 flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" />
            Possible duplicate — {Math.round(question.similarity_score * 100)}% similar to question{' '}
            <span className="font-mono font-bold">{question.similar_question_id}</span>
          </p>
          {question.similar_question_id && (
            <button
              onClick={() => onViewDuplicate(question)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-amber-200 bg-amber-50 text-amber-300 hover:bg-amber-900 hover:text-white transition-all cursor-pointer shrink-0"
            >
              <Copy className="w-3.5 h-3.5" /> View Side-by-Side
            </button>
          )}
        </div>
      )}
      {/* Explanation Block */}
      <div className="border border-[#e4e4e7] rounded-xl overflow-hidden mt-2 bg-[#f2f2f3]">
        <button
          onClick={() => setIsExpOpen(!isExpOpen)}
          className="w-full flex justify-between items-center px-4 py-3 bg-[#fafafa] hover:bg-[#f2f2f3]/80 transition-all text-xs font-bold text-zinc-500 select-none cursor-pointer border-b border-[#e4e4e7]"
        >
          <span className="flex items-center gap-1.5 uppercase tracking-wide">
            <AlertCircle className="w-3.5 h-3.5 text-zinc-500" /> Key Answer &amp; Explanation
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[12px] bg-emerald-50 text-emerald-600 font-extrabold px-2 py-0.5 rounded-md border border-emerald-200">
              CORRECT ANSWER: {question.correct_answer}
            </span>
            {isExpOpen ? <ChevronUp className="w-3.5 h-3.5 text-zinc-500" /> : <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />}
          </div>
        </button>

        {isExpOpen && (
          <div className="p-4 border-t border-[#e4e4e7] text-xs text-zinc-600 leading-relaxed font-sans bg-[#fafafa]">
            <p className="font-medium text-zinc-900 mb-1 flex items-center gap-1">
              <HelpCircle className="w-3.5 h-3.5 text-emerald-600" /> Explanation Details:
            </p>
            {question.explanation}
          </div>
        )}
      </div>

      {/* Threaded reviewer comments (spec §6: multiple, timestamped, attributed comments per question) */}
      <div className="border border-[#e4e4e7] rounded-xl overflow-hidden bg-[#f2f2f3]">
        <div className="flex items-center gap-1.5 px-4 py-2.5 bg-[#fafafa] border-b border-[#e4e4e7] text-xs font-bold text-zinc-500 uppercase tracking-wide select-none">
          <MessageSquare className="w-3.5 h-3.5 text-sky-600" /> Comments
          <span className="normal-case font-medium text-[11px] text-zinc-600 ml-1">
            (thread — e.g. why something was rejected, or a re-review note after a fix)
          </span>
          {question.comments && question.comments.length > 0 && (
            <span className="ml-auto font-mono text-[11px] text-zinc-500">{question.comments.length}</span>
          )}
        </div>
        <div className="p-3 flex flex-col gap-3">
          {/* Existing thread, oldest first, each attributed + timestamped */}
          {question.comments && question.comments.length > 0 && (
            <div className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
              {question.comments.map((c) => (
                <div key={c.id} className="text-xs bg-white border border-[#e4e4e7] rounded-lg p-2.5">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-sky-600">{c.author}</span>
                    <span className="text-[11px] text-zinc-600">
                      {new Date(c.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-zinc-600 leading-relaxed whitespace-pre-wrap">{c.text}</p>
                </div>
              ))}
            </div>
          )}

          {/* New comment composer — comments are appended, never overwritten. Read-only for auditors. */}
          {!isAuditor && (
            <>
              <textarea
                value={newCommentDraft}
                onChange={(e) => setNewCommentDraft(e.target.value)}
                placeholder="e.g. Choice B is arguably also correct — Claude keeps missing this pattern with negation questions..."
                rows={2}
                className="w-full text-xs text-zinc-700 bg-white border border-[#e4e4e7] rounded-lg p-2.5 focus:outline-none focus:ring-1 focus:ring-sky-600 focus:border-sky-600 placeholder:text-zinc-600 resize-y leading-relaxed"
              />
              <div className="flex justify-end">
                <button
                  onClick={() => {
                    if (!newCommentDraft.trim()) return;
                    onAddComment(question.id, newCommentDraft);
                    setNewCommentDraft('');
                  }}
                  disabled={!newCommentDraft.trim()}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold rounded-lg border transition-all ${newCommentDraft.trim()
                      ? 'border-sky-200 bg-sky-50 text-sky-600 hover:bg-sky-900 hover:text-zinc-900 cursor-pointer'
                      : 'border-[#e4e4e7] text-zinc-600 cursor-not-allowed'
                    }`}
                >
                  <Check className="w-3 h-3" /> Add Comment
                </button>
              </div>
            </>
          )}
        </div>
      </div>


      {/* Validation Actions checklist (spec §5) — 4 independent checks, no blanket approve */}
      <div
        className={`border border-[#e4e4e7] rounded-xl overflow-hidden bg-[#f2f2f3] select-none ${(isLockedByOther || isAuditor) ? 'opacity-50 pointer-events-none' : ''}`}
        title={isLockedByOther ? `Locked — claimed by ${question.claimedByName || 'another validator'}` : isAuditor ? 'Auditors have read-only access' : undefined}
      >
        <div className="flex items-center gap-1.5 px-4 py-2.5 bg-[#fafafa] border-b border-[#e4e4e7] text-xs font-bold text-zinc-500 uppercase tracking-wide">
          <ShieldCheck className="w-3.5 h-3.5 text-indigo-600" /> Validation Checklist
          <span className="normal-case font-medium text-[11px] text-zinc-600 ml-1">
            (a "No" on any check sends this to Needs Revision; four "Yes" checks unlock Approve below)
          </span>
        </div>

        <div className="flex flex-col divide-y divide-[#e4e4e7]">
          {/* 1. Question formation */}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-xs text-zinc-600">Question formation correct</span>
            <CheckToggle
              value={question.formationOk}
              onYes={() => handleYes('formationOk')}
              onNo={() => requestFail('formationOk', 'Question formation')}
              onReset={() => handleReset('formationOk')}
              isPendingNo={!!pendingFailures.formationOk}
            />
          </div>

          {/* 2. Answer correctness */}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-xs text-zinc-600">Answer correctness confirmed</span>
            <CheckToggle
              value={question.answerOk}
              onYes={() => handleYes('answerOk')}
              onNo={() => requestFail('answerOk', 'Answer correctness')}
              onReset={() => handleReset('answerOk')}
              isPendingNo={!!pendingFailures.answerOk}
            />
          </div>

          {/* 3. Category/skill tag correct, with reassign dropdown if wrong */}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 flex-wrap">
            <span className="text-xs text-zinc-600">Category/skill tag correct</span>
            <div className="flex items-center gap-2">
              {(question.categoryOk === false || !!pendingFailures.categoryOk) && (
                <>
                  <select
                    value={categoryDraft}
                    onChange={(e) => setCategoryDraft(e.target.value)}
                    className="text-[12px] bg-white border border-[#e4e4e7] rounded-md px-2 py-1 text-zinc-700 focus:outline-none focus:ring-1 focus:ring-indigo-600"
                  >
                    {allCategories.map(c => (
                      <option key={c} value={c} className="bg-white">{c}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      onCategoryOverride(question.id, categoryDraft);
                      if (pendingFailures.categoryOk) {
                        setPendingFailures(prev => {
                          const next = { ...prev };
                          delete next.categoryOk;
                          if (Object.keys(next).length === 0) {
                            setFailureCommentDraft('');
                          }
                          return next;
                        });
                      }
                    }}
                    className="px-2 py-1 text-[12px] font-bold rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-700 hover:text-white transition-all cursor-pointer"
                  >
                    Reassign
                  </button>
                </>
              )}
              <CheckToggle
                value={question.categoryOk}
                onYes={() => handleYes('categoryOk')}
                onNo={() => requestFail('categoryOk', 'Category/skill tag')}
                onReset={() => handleReset('categoryOk')}
                isPendingNo={!!pendingFailures.categoryOk}
              />
            </div>
          </div>

          {/* 4. Difficulty level correct, with reassign dropdown if wrong */}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 flex-wrap">
            <span className="text-xs text-zinc-600">Difficulty level correct</span>
            <div className="flex items-center gap-2">
              {(question.difficultyOk === false || !!pendingFailures.difficultyOk) && (
                <>
                  <select
                    value={difficultyDraft}
                    onChange={(e) => setDifficultyDraft(e.target.value as 'easy' | 'medium' | 'hard')}
                    className="text-[12px] bg-white border border-[#e4e4e7] rounded-md px-2 py-1 text-zinc-700 focus:outline-none focus:ring-1 focus:ring-indigo-600"
                  >
                    <option value="easy" className="bg-white">Easy</option>
                    <option value="medium" className="bg-white">Medium</option>
                    <option value="hard" className="bg-white">Hard</option>
                  </select>
                  <button
                    onClick={() => {
                      onDifficultyOverride(question.id, difficultyDraft);
                      if (pendingFailures.difficultyOk) {
                        setPendingFailures(prev => {
                          const next = { ...prev };
                          delete next.difficultyOk;
                          if (Object.keys(next).length === 0) {
                            setFailureCommentDraft('');
                          }
                          return next;
                        });
                      }
                    }}
                    className="px-2 py-1 text-[12px] font-bold rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-700 hover:text-white transition-all cursor-pointer"
                  >
                    Reassign
                  </button>
                </>
              )}
              <CheckToggle
                value={question.difficultyOk}
                onYes={() => handleYes('difficultyOk')}
                onNo={() => requestFail('difficultyOk', 'Difficulty level')}
                onReset={() => handleReset('difficultyOk')}
                isPendingNo={!!pendingFailures.difficultyOk}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Approve action (spec §5): all four checks passing only unlocks this button —
          it never fires on its own. Approval itself is a separate, deliberate click. */}
      {question.formationOk === true && question.answerOk === true &&
        question.categoryOk === true && question.difficultyOk === true &&
        question.reviewStatus !== 'approved' && !isLockedByOther && !isAuditor && (
        <button
          onClick={() => onApprove(question.id)}
          className="flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 transition-all cursor-pointer"
        >
          <CheckCircle2 className="w-4 h-4" /> Approve for Test Bank
        </button>
      )}

      {/* Required-comment prompt (spec §6): shown the moment a check is marked "No" */}
      {Object.keys(pendingFailures).length > 0 && (
        <div className="border border-rose-200 rounded-xl overflow-hidden bg-rose-50">
          <div className="flex items-center gap-1.5 px-4 py-2.5 bg-rose-50 border-b border-rose-200 text-xs font-bold text-rose-600 uppercase tracking-wide">
            <AlertCircle className="w-3.5 h-3.5" /> Comment required — "{Object.values(pendingFailures).join(', ')}" marked incorrect
          </div>
          <div className="p-3 flex flex-col gap-2">
            <textarea
              autoFocus
              value={failureCommentDraft}
              onChange={(e) => setFailureCommentDraft(e.target.value)}
              placeholder="Explain what's wrong so this can be fixed and re-reviewed..."
              rows={2}
              className="w-full text-xs text-zinc-700 bg-white border border-rose-200 rounded-lg p-2.5 focus:outline-none focus:ring-1 focus:ring-rose-600 placeholder:text-zinc-600 resize-y leading-relaxed"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setPendingFailures({}); setFailureCommentDraft(''); }}
                className="px-3 py-1.5 text-[12px] font-bold rounded-lg border border-[#e4e4e7] bg-white text-zinc-500 hover:bg-[#e4e4e7] hover:text-zinc-900 transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={confirmFailure}
                disabled={!failureCommentDraft.trim()}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold rounded-lg border transition-all ${failureCommentDraft.trim()
                    ? 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-800 hover:text-white cursor-pointer'
                    : 'border-[#e4e4e7] text-zinc-600 cursor-not-allowed'
                  }`}
              >
                <Check className="w-3 h-3" /> Confirm "No" &amp; Save Comment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Second-reviewer / consensus check (spec §7): only for sampled items, read-only for auditors.
          One validator (whoever claimed this item) does the PRIMARY review above; up to
          MAX_CONSENSUS_REVIEWERS OTHER validators can each leave an independent second opinion here.
          If the two sides disagree, an admin steps in to resolve it. */}
      {question.requiresSecondReview && !isAuditor && (() => {
        const resolution = getConsensusResolution(question);
        const iAmPrimary = !!question.claimedBy && question.claimedBy === currentUserId;
        const verdictLabel = (v: 'approved' | 'needs_revision' | 'pending') =>
          v === 'approved' ? 'Approved' : v === 'needs_revision' ? 'Needs Revision' : 'Pending';
        const verdictColor = (v: 'approved' | 'needs_revision' | 'pending') =>
          v === 'approved' ? 'text-emerald-600' : v === 'needs_revision' ? 'text-rose-600' : 'text-zinc-500';

        return (
          <div className="border border-violet-900/30 rounded-xl overflow-hidden bg-[#f2f2f3]">
            <div className="flex items-center justify-between gap-1.5 px-4 py-2.5 bg-violet-950/10 border-b border-violet-900/30">
              <span className="text-xs font-bold text-violet-400 uppercase tracking-wide">
                🔁 Primary Review + Second Opinions
              </span>
              <span className="text-[12px] font-mono text-zinc-500">
                {resolution.secondOpinions.length}/{MAX_CONSENSUS_REVIEWERS} second opinions
              </span>
            </div>
            <div className="p-3 flex flex-col gap-3">

              {/* Primary vs. second-opinion verdict comparison */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-white border border-[#e4e4e7] rounded-lg px-2.5 py-2">
                  <p className="text-[11px] text-zinc-500 uppercase font-bold tracking-wider">Primary reviewer</p>
                  <p className={`text-xs font-bold mt-0.5 ${verdictColor(resolution.primaryVerdict)}`}>
                    {verdictLabel(resolution.primaryVerdict)}
                  </p>
                  {question.claimedByName && (
                    <p className="text-[11px] text-zinc-600 mt-0.5">{question.claimedByName}</p>
                  )}
                </div>
                <div className="bg-white border border-[#e4e4e7] rounded-lg px-2.5 py-2">
                  <p className="text-[11px] text-zinc-500 uppercase font-bold tracking-wider">Second opinions</p>
                  <p className={`text-xs font-bold mt-0.5 ${resolution.secondOpinionVerdict ? verdictColor(resolution.secondOpinionVerdict) : 'text-zinc-500'}`}>
                    {resolution.secondOpinionVerdict ? verdictLabel(resolution.secondOpinionVerdict) : 'Awaiting quorum'}
                  </p>
                  <p className="text-[11px] text-zinc-600 mt-0.5">
                    {resolution.secondOpinionApproved} approved / {resolution.secondOpinionNeedsRevision} needs revision
                  </p>
                </div>
              </div>

              {resolution.secondOpinions.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {resolution.secondOpinions.map(r => (
                    <div key={r.validatorId} className="text-[12px] bg-white border border-[#e4e4e7] rounded-lg px-2.5 py-2 flex items-center justify-between gap-2">
                      <span className="text-zinc-600 font-semibold">{r.validatorName}</span>
                      <span className="text-zinc-500 font-mono">
                        {[r.formationOk, r.answerOk, r.categoryOk, r.difficultyOk].map(v => v === true ? '✓' : v === false ? '✗' : '·').join(' ')}
                      </span>
                      <span className="text-zinc-600">{new Date(r.timestamp).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Disagreement callout + admin resolution */}
              {resolution.hasDisagreement && (
                <div className="border border-amber-200 bg-amber-50 rounded-lg p-2.5 flex flex-col gap-2">
                  <p className="text-[12px] text-amber-700 font-semibold flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    Primary reviewer and second opinions disagree — needs admin resolution.
                  </p>
                  {isAdmin && onResolveConsensus ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => onResolveConsensus(question.id, 'primary')}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold rounded-lg border border-[#e4e4e7] bg-white text-zinc-600 hover:bg-[#e4e4e7] hover:text-zinc-900 transition-all cursor-pointer"
                      >
                        Keep Primary ({verdictLabel(resolution.primaryVerdict)})
                      </button>
                      <button
                        onClick={() => onResolveConsensus(question.id, 'second_opinion')}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold rounded-lg border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-900 hover:text-white transition-all cursor-pointer"
                      >
                        Apply Second Opinions ({resolution.secondOpinionVerdict ? verdictLabel(resolution.secondOpinionVerdict) : ''})
                      </button>
                    </div>
                  ) : (
                    <p className="text-[11px] text-zinc-500">An admin will review both sides and set the final status.</p>
                  )}
                </div>
              )}

              {/* Second-opinion submission form — hidden for the primary reviewer, who already reviewed above */}
              {iAmPrimary ? (
                <p className="text-[12px] text-zinc-600 italic">
                  You're the primary reviewer on this item — your checklist above already counts as the primary review.
                  Second opinions come from other validators.
                </p>
              ) : (
                <>
                  <p className="text-[12px] text-zinc-600">
                    Submit your own independent checks below (used for the admin inter-rater agreement metric — this does not
                    overwrite the primary checklist above).
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      ['formationOk', 'Formation'],
                      ['answerOk', 'Answer'],
                      ['categoryOk', 'Category'],
                      ['difficultyOk', 'Difficulty']
                    ] as const).map(([field, label]) => (
                      <div key={field} className="flex items-center justify-between gap-2 bg-white border border-[#e4e4e7] rounded-lg px-2.5 py-1.5">
                        <span className="text-[12px] text-zinc-500">{label}</span>
                        <CheckToggle
                          value={consensusDraft[field]}
                          onYes={() => setConsensusDraft(prev => ({ ...prev, [field]: true }))}
                          onNo={() => setConsensusDraft(prev => ({ ...prev, [field]: false }))}
                          onReset={() => setConsensusDraft(prev => ({ ...prev, [field]: null }))}
                        />
                      </div>
                    ))}
                  </div>
                  {(() => {
                    const iAlreadyReviewed = resolution.secondOpinions.some(r => r.validatorId === currentUserId);
                    const isFull = !iAlreadyReviewed && resolution.secondOpinions.length >= MAX_CONSENSUS_REVIEWERS;
                    const isDisabled = isFull || Object.values(consensusDraft).every(v => v === null);
                    return (
                      <>
                        {isFull && (
                          <p className="text-[12px] text-amber-500">
                            This question already has {MAX_CONSENSUS_REVIEWERS} independent second opinions — no more can be added.
                          </p>
                        )}
                        <button
                          onClick={() => onSubmitConsensusReview(question.id, consensusDraft)}
                          disabled={isDisabled}
                          className={`self-end flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold rounded-lg border transition-all ${isDisabled
                              ? 'border-[#e4e4e7] text-zinc-600 cursor-not-allowed'
                              : 'border-violet-900/40 bg-violet-950/20 text-violet-400 hover:bg-violet-900 hover:text-zinc-900 cursor-pointer'
                            }`}
                        >
                          <Check className="w-3 h-3" /> {iAlreadyReviewed ? 'Update My Second Opinion' : 'Submit Second Opinion'}
                        </button>
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          </div>
        );
      })()}


      <div className="border border-[#e4e4e7] rounded-xl overflow-hidden bg-[#f2f2f3]">
        <button
          onClick={() => setOverrideOpen(!overrideOpen)}
          className="w-full flex justify-between items-center px-4 py-2.5 bg-[#fafafa] hover:bg-[#f2f2f3]/80 transition-all text-xs font-bold text-zinc-500 select-none cursor-pointer"
        >
          <span className="flex items-center gap-1.5 uppercase tracking-wide">
            <Settings2 className="w-3.5 h-3.5 text-sky-600" /> Manual Status Override
          </span>
          {overrideOpen ? <ChevronUp className="w-3.5 h-3.5 text-zinc-500" /> : <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />}
        </button>
        {overrideOpen && (
          <div className="p-3 flex flex-col gap-2 border-t border-[#e4e4e7]">
            {question.statusOverride && (
              <div className="text-[12px] text-sky-600 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">
                Currently overridden to <strong>{question.statusOverride.replace('_', ' ')}</strong>: {question.statusOverrideJustification}
              </div>
            )}
            {!isAuditor && (
              <>
                <select
                  value={overrideStatusDraft}
                  onChange={(e) => setOverrideStatusDraft(e.target.value as 'approved' | 'rejected' | 'needs_revision')}
                  className="text-xs bg-white border border-[#e4e4e7] rounded-lg px-2.5 py-1.5 text-zinc-700 focus:outline-none focus:ring-1 focus:ring-sky-600"
                >
                  <option value="approved" className="bg-white">Approved</option>
                  <option value="needs_revision" className="bg-white">Needs Revision</option>
                  <option value="rejected" className="bg-white">Rejected</option>
                </select>
                <textarea
                  value={overrideJustificationDraft}
                  onChange={(e) => setOverrideJustificationDraft(e.target.value)}
                  placeholder="Required: explain why you're overriding the auto-derived status..."
                  rows={2}
                  className="w-full text-xs text-zinc-700 bg-white border border-[#e4e4e7] rounded-lg p-2.5 focus:outline-none focus:ring-1 focus:ring-sky-600 placeholder:text-zinc-600 resize-y leading-relaxed"
                />
                <div className="flex justify-end gap-2">
                  {question.statusOverride && (
                    <button
                      onClick={() => onClearOverride(question.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold rounded-lg border border-[#e4e4e7] bg-white text-zinc-500 hover:bg-[#e4e4e7] hover:text-zinc-900 transition-all cursor-pointer"
                    >
                      Clear Override
                    </button>
                  )}
                  <button
                    onClick={() => {
                      onManualOverride(question.id, overrideStatusDraft, overrideJustificationDraft);
                      setOverrideJustificationDraft('');
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold rounded-lg border border-sky-200 bg-sky-50 text-sky-600 hover:bg-sky-900 hover:text-zinc-900 transition-all cursor-pointer"
                  >
                    <Check className="w-3 h-3" /> Apply Override
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Question Curation Audit Log History Timeline (spec §8) */}
      <div className="border border-[#e4e4e7] rounded-xl overflow-hidden bg-[#f2f2f3]">
        <button
          type="button"
          onClick={() => setIsAuditOpen(!isAuditOpen)}
          className="w-full flex justify-between items-center px-4 py-2.5 bg-[#fafafa] hover:bg-[#f2f2f3]/80 transition-all text-xs font-bold text-zinc-500 select-none cursor-pointer"
        >
          <span className="flex items-center gap-1.5 uppercase tracking-wide">
            <History className="w-3.5 h-3.5 text-indigo-600" /> Curation Audit Trail
          </span>
          <div className="flex items-center gap-2">
            {auditLogs && auditLogs.length > 0 && (
              <span className="font-mono text-[11px] text-zinc-500 bg-white px-2 py-0.5 rounded-full border border-[#e4e4e7]">
                {auditLogs.length} event(s)
              </span>
            )}
            {isAuditOpen ? <ChevronUp className="w-3.5 h-3.5 text-zinc-500" /> : <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />}
          </div>
        </button>
        {isAuditOpen && (
          <div className="p-3 flex flex-col gap-2 border-t border-[#e4e4e7] max-h-56 overflow-y-auto bg-[#fafafa]">
            {auditLogs && auditLogs.length > 0 ? (
              <div className="flex flex-col gap-2">
                {auditLogs.map(log => (
                  <div key={log.id} className="text-[12px] bg-white border border-[#e4e4e7] rounded-lg p-2.5 space-y-1">
                    <div className="flex items-center justify-between text-[11px] font-mono text-zinc-500">
                      <span className="font-semibold text-indigo-600 uppercase tracking-wide">
                        {log.action.toUpperCase()}
                      </span>
                      <span>{log.timestamp}</span>
                    </div>
                    <p className="text-zinc-600 leading-relaxed font-sans">{log.description}</p>
                    {log.user && (
                      <p className="text-[11px] text-zinc-500 font-mono">Curator: {log.user}</p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-zinc-500 italic text-center py-2 bg-white rounded-lg">
                No activity logged for this item yet.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Footer: quick edit + reset — hidden entirely for read-only auditors */}
      {!isAuditor && (
        <div className="flex flex-wrap justify-between items-center gap-3 pt-2 select-none">
          <button
            onClick={() => onEdit(question)}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-zinc-500 hover:text-zinc-900 border border-[#e4e4e7] hover:bg-[#f2f2f3] rounded-lg transition-all cursor-pointer"
          >
            <Edit3 className="w-3.5 h-3.5" /> Quick Edit Item
          </button>

          {!isPending && (
            <button
              onClick={() => onResetStatus(question.id)}
              title="Reset checklist and status to Pending Review"
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-zinc-500 hover:text-zinc-600 border border-[#e4e4e7] rounded-lg hover:bg-[#f2f2f3] transition-all cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Reset to Pending
            </button>
          )}
        </div>
      )}

      {/* Next Question — available to auditors too, since it's just navigation */}
      {hasNext && onNext && (
        <div className="flex justify-end pt-2 select-none">
          <button
            onClick={onNext}
            title="Scroll to the next question in this list"
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#6366f1] hover:bg-indigo-700 border border-[#6366f1] rounded-lg transition-all cursor-pointer"
          >
            Next Question <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Desmos Graphing Calculator modal (Enhancement §1) — Math questions only,
          opens without navigating away from this review page. */}
      {isMath && (
        <DesmosModal
          open={isDesmosOpen}
          onClose={() => setIsDesmosOpen(false)}
          initialExpressions={mathExpressions}
          questionId={question.id}
        />
      )}
    </motion.div>
  );
}