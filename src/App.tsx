import React, { useState, useEffect, useRef, useMemo } from 'react';
import { SATQuestion, FilterState, StatsSummary, QuestionComment, SortField, SortDirection, ValidatorInvite, MAX_CONSENSUS_REVIEWERS, QuestionSnapshot, ConsensusReview } from './types';
import StatsGrid from './components/StatsGrid';
import FiltersPanel from './components/FiltersPanel';
import StatsCharts from './components/StatsCharts';
import QuestionCard from './components/QuestionCard';
import EditModal from './components/EditModal';
import DomainAnalytics from './components/DomainAnalytics';
import AuditActivityLogs, { AuditLogEntry } from './components/AuditActivityLogs';
import DuplicateCompareModal from './components/DuplicateCompareModal';
import QuestionHistoryDrawer from './components/QuestionHistoryDrawer';
import AdminPanel from './components/AdminPanel';
import NewBatchWorkspace from './components/NewBatchWorkspace';
import ValidatorProgressModal from './components/ValidatorProgressModal';
import Login from './components/Login';
import UpdatePassword from './components/UpdatePassword';
import { supabase, Profile } from './lib/supabaseClient';
import { rowToQuestion, questionToRow, QuestionRow } from './lib/mappers';
import { getConsensusResolution } from './lib/consensus';
import type { Session } from '@supabase/supabase-js';
import {
  Upload,
  Download,
  Trash2,
  FileText,
  ClipboardCopy,
  Check,
  Info,
  X,
  Layers,
  History,
  PieChart,
  User,
  LogOut,
  ShieldCheck,
  Clock,
  FileSpreadsheet,
  Undo2,
  AlertTriangle,
  ChevronDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';

// Stable reference for the "no audit logs yet" case, so React.memo on
// QuestionCard doesn't see a "new" auditLogs prop (a fresh [] literal) on
// every render for questions with no history.
const EMPTY_AUDIT_LOGS: AuditLogEntry[] = [];

export default function App() {
  // --- Auth state (spec §2) ---
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  // Bug fix (Forgot Password flow): when a reset link is expired, already
  // used, or otherwise invalid, Supabase does NOT send the user to
  // type=recovery — it redirects back to the app with an error in the hash
  // (e.g. #error=access_denied&error_code=otp_expired&error_description=...).
  // Previously nothing read this, so the app just fell through to a bare
  // <Login/> with zero explanation — indistinguishable from "click Forgot
  // Password and get bounced back to Sign In". This surfaces that error so
  // the person can request a fresh link instead of silently failing.
  const [authLinkError, setAuthLinkError] = useState<string | null>(null);

  useEffect(() => {
    // Bug fix: Supabase's PASSWORD_RECOVERY auth event is unreliable — on
    // invite links especially, only SIGNED_IN fires and PASSWORD_RECOVERY
    // never does (a known supabase-js issue: the invite/recovery link logs
    // the user in immediately, before they've set a password, and the event
    // meant to gate that moment often silently doesn't show up). Relying on
    // it left new validators fully "logged in" with no password ever set —
    // fine until they log out, at which point there's nothing to log back
    // in with. Instead, check the URL directly for what Supabase actually
    // put there (type=invite or type=recovery), which is reliable
    // regardless of which event does or doesn't fire.
    const hash = window.location.hash;
    if (hash.includes('type=invite') || hash.includes('type=recovery')) {
      setPasswordRecovery(true);
    } else if (hash.includes('error=')) {
      const params = new URLSearchParams(hash.replace(/^#/, ''));
      const code = params.get('error_code');
      const description = params.get('error_description');
      if (code === 'otp_expired') {
        setAuthLinkError('That password reset link has expired. Request a new one below.');
      } else if (params.get('error') === 'access_denied') {
        setAuthLinkError('That password reset link is invalid or has already been used. Request a new one below.');
      } else if (description) {
        setAuthLinkError(decodeURIComponent(description.replace(/\+/g, ' ')));
      }
    }
    // Clean the hash out of the URL once we've read it so a page refresh
    // doesn't re-trigger recovery mode or re-show a stale error.
    if (hash.includes('type=invite') || hash.includes('type=recovery') || hash.includes('error=')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      // Bug fix (stats flicker on tab switch): Supabase fires this listener
      // on every token refresh, including the silent refresh that happens
      // when the browser tab regains focus. That handed us a new session
      // object for the *same* user, which made the [session]-keyed data
      // fetch effect below think the session changed and re-run its whole
      // paginated load from scratch — briefly showing partial counts (e.g.
      // 1000 of 1672) until it re-streamed the rest of the table back in.
      // Only update state (and thus re-trigger that effect) when the
      // logged-in user actually changes, not on every silent token refresh.
      setSession(prev => (prev?.user.id === newSession?.user.id ? prev : newSession));
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const [pendingApproval, setPendingApproval] = useState(false);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      setPendingApproval(false);
      return;
    }
    let cancelled = false;
    const fetchProfile = (isRetry: boolean) => {
      supabase
        .from('profiles')
        .select('id, email, name, role, active')
        .eq('id', session.user.id)
        .single()
        .then(({ data, error }) => {
          if (cancelled) return;
          if (!error && data) {
            if (!(data as Profile).active) {
              setPendingApproval(true);
              return;
            }
            setPendingApproval(false);
            setProfile(data as Profile);
          } else if (!isRetry) {
            // Transient failure (e.g. token not yet propagated on reload) —
            // retry once instead of leaving profile null, which silently
            // dropped the display name and admin tag.
            setTimeout(() => fetchProfile(true), 800);
          }
        });
    };
    fetchProfile(false);
    return () => { cancelled = true; };
  }, [session]);

  const validatorName = profile?.name || session?.user.email || 'Unnamed Validator';
  const isAdmin = profile?.role === 'admin';
  // Read-only/Auditor role (spec §2): can view everything, cannot write anything.
  const isAuditor = profile?.role === 'auditor';

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  // --- Idle timeout (spec §2): auto sign-out after 30 minutes of no interaction ---
  useEffect(() => {
    if (!session) return;
    const IDLE_LIMIT_MS = 30 * 60 * 1000;
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        supabase.auth.signOut();
      }, IDLE_LIMIT_MS);
    };
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach(ev => window.addEventListener(ev, resetTimer));
    resetTimer();
    return () => {
      clearTimeout(idleTimer);
      events.forEach(ev => window.removeEventListener(ev, resetTimer));
    };
  }, [session]);

  // --- Validators list (spec §3 assignment, admin panel, filters) ---
  const [validators, setValidators] = useState<Profile[]>([]);
  const refreshValidators = () => {
    if (!session) return;
    supabase.from('profiles').select('id, email, name, role, active, invite_pending').order('name').then(({ data, error }) => {
      if (!error && data) setValidators(data as Profile[]);
    });
  };
  useEffect(() => {
    refreshValidators();
  }, [session]);

  // --- Daily validator progress export modal (admin-only) ---
  const [showValidatorProgressModal, setShowValidatorProgressModal] = useState(false);

  // --- Pre-authorized validator invites (spec §2 admin invite) ---
  const [invites, setInvites] = useState<ValidatorInvite[]>([]);
  const refreshInvites = () => {
    if (!session) return;
    supabase.from('validator_invites').select('*').order('invited_at', { ascending: false }).then(({ data, error }) => {
      if (!error && data) setInvites(data as ValidatorInvite[]);
    });
  };
  useEffect(() => {
    if (session && isAdmin) {
      refreshInvites();
    }
  }, [session, isAdmin]);

  // --- App settings: rejection webhook URL, consensus sample rate (spec §7, §13) ---
  const [settings, setSettings] = useState<{ rejection_webhook_url: string | null; consensus_sample_rate: number }>({
    rejection_webhook_url: null,
    consensus_sample_rate: 0.1
  });
  useEffect(() => {
    if (!session) return;
    supabase.from('app_settings').select('*').eq('id', 1).single().then(({ data, error }) => {
      if (!error && data) setSettings(data as any);
    });
  }, [session]);

  // --- Core States ---
  const [questions, setQuestions] = useState<SATQuestion[]>([]);
  // Bug fix (stats flicker): saveQuestions writes optimistically to local
  // state, then fires an async Supabase write. The realtime subscription
  // below hears that same write echoed back — and when a question is
  // updated several times in quick succession (e.g. clicking all four Yes
  // checks back-to-back), those echoes can resolve out of order and briefly
  // overwrite fresher local state with a stale snapshot, making counts in
  // StatsGrid jump/flicker before settling. This tracks how many writes are
  // still in flight per question id so the realtime handler can ignore
  // self-echoes until this client's own writes for that id are done.
  const pendingWritesRef = useRef<Map<string, number>>(new Map());
  const [activeTab, setActiveTab] = useState<'curator' | 'newbatch' | 'analytics' | 'audit' | 'admin'>('curator');

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

  // --- Sort control (spec §3) ---
  const [sortField, setSortField] = useState<SortField>('dateGenerated');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  // Custom toast notification system
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [clearConfirmTypedText, setClearConfirmTypedText] = useState('');
  const [selectedEditQuestion, setSelectedEditQuestion] = useState<SATQuestion | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // --- Point 6: side-by-side duplicate compare modal state ---
  const [duplicateCompareQuestion, setDuplicateCompareQuestion] = useState<SATQuestion | null>(null);

  // --- Export dropdown (Approved / Rejected / Needs Revision / Total Test
  // Bank, each as JSON or Excel) — see exportBucketAsJson/exportBucketAsExcel below.
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isExportMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setIsExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isExportMenuOpen]);

  // --- Per-question revert history (admin-only "History" drawer) ---
  const [historyDrawerQuestion, setHistoryDrawerQuestion] = useState<SATQuestion | null>(null);
  const handleOpenHistory = (question: SATQuestion) => setHistoryDrawerQuestion(question);
  const handleCloseHistory = () => setHistoryDrawerQuestion(null);

  // --- Activity Logs state (now backed by Supabase, shared across validators) ---
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);

  // --- Bulk action safety net ---
  // Any bulk approve/reject requires this confirmation step, and the user
  // must always type CONFIRM before it touches the DB — this is what stops
  // an accidental "Approve All Filtered" click (e.g. with no filters set)
  // from silently approving everything.
  type BulkActionType = 'approve_filtered' | 'reject_filtered' | 'approve_selected' | 'reject_selected';
  const [bulkConfirm, setBulkConfirm] = useState<{
    actionType: BulkActionType;
    status: 'approved' | 'rejected';
    ids: string[];
  } | null>(null);
  const [bulkConfirmTypedText, setBulkConfirmTypedText] = useState('');
  const [isSubmittingBulk, setIsSubmittingBulk] = useState(false);

  // Most recent not-yet-undone bulk snapshot, so "Undo Last Bulk Action" can
  // restore exactly the questions that action touched — and only those.
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
    if (!session) return;
    refreshLastBulkSnapshot();
  }, [session]);

  // --- Initial Load + Realtime subscriptions (spec §7: near-real-time sync) ---
  useEffect(() => {
    if (!session) return;

    let cancelled = false;

    (async () => {
      // --- Performance (spec §11): fetch in 1000-row pages instead of one
      // single select('*') over the whole table, and stream each page into
      // state as it arrives so the first batch renders immediately instead
      // of blocking on the entire table. Full server-side pagination (only
      // ever loading the current page/filter from the DB) would need the
      // client-side filter/sort/realtime-merge logic reworked into query
      // params — noted as still-open further down the line.
      const PAGE = 1000;
      let from = 0;
      let first = true;
      while (!cancelled) {
        const { data: qRows, error: qError } = await supabase
          .from('questions')
          .select('*')
          .order('created_at', { ascending: false })
          .range(from, from + PAGE - 1);
        if (qError || !qRows) break;
        if (first) {
          setQuestions((qRows as QuestionRow[]).map(rowToQuestion));
          first = false;
        } else {
          const incoming = (qRows as QuestionRow[]).map(rowToQuestion);
          setQuestions(prev => {
            const seen = new Set(prev.map(q => q.id));
            return [...prev, ...incoming.filter(q => !seen.has(q.id))];
          });
        }
        if (qRows.length < PAGE) break;
        from += PAGE;
      }

      const start14DaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const { count } = await supabase
        .from('audit_log')
        .select('id', { count: 'exact', head: true })
        .gte('timestamp', start14DaysAgo);

      if (!cancelled && count && count > 0) {
        const PAGE = 1000;
        const totalPages = Math.ceil(count / PAGE);
        const pagePromises = Array.from({ length: totalPages }, (_, i) =>
          supabase
            .from('audit_log')
            .select('id, timestamp, action, question_id, description, user_name, user_id')
            .gte('timestamp', start14DaysAgo)
            .order('timestamp', { ascending: false })
            .range(i * PAGE, (i + 1) * PAGE - 1)
        );
        const results = await Promise.all(pagePromises);
        const allRows: any[] = [];
        for (const res of results) {
          if (res.data) allRows.push(...res.data);
        }
        if (!cancelled) {
          setLogs(allRows.map((r: any) => ({
            id: r.id,
            timestamp: new Date(r.timestamp).toLocaleString(),
            rawTimestamp: r.timestamp,
            action: r.action,
            questionId: r.question_id || undefined,
            description: r.description,
            user: r.user_name || undefined,
            userId: r.user_id || undefined
          })));
        }
      }
    })();

    const questionsChannel = supabase
      .channel('questions-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'questions' }, (payload) => {
        setQuestions(prev => {
          if (payload.eventType === 'DELETE') {
            return prev.filter(q => q.id !== (payload.old as any).id);
          }
          const incoming = rowToQuestion(payload.new as QuestionRow);
          // Ignore echoes of our own still-in-flight writes (see
          // pendingWritesRef above) — local state for this id is already
          // at least as fresh as this event.
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

    const logsChannel = supabase
      .channel('audit-log-changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_log' }, (payload) => {
        const r: any = payload.new;
        setLogs(prev => [{
          id: r.id,
          timestamp: new Date(r.timestamp).toLocaleString(),
          rawTimestamp: r.timestamp,
          action: r.action,
          questionId: r.question_id || undefined,
          description: r.description,
          user: r.user_name || undefined,
          userId: r.user_id || undefined
        }, ...prev]);
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(questionsChannel);
      supabase.removeChannel(logsChannel);
    };
  }, [session]);

  // --- Toast Trigger Helper ---
  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  // --- Auditor write-guard (spec §2): defense-in-depth behind the UI-level
  // gating in QuestionCard — any mutating handler bails out for auditors. ---
  const blockIfAuditor = () => {
    if (isAuditor) {
      showToast('Auditors have read-only access.', 'error');
      return true;
    }
    return false;
  };

  // --- Persist changed questions to Supabase (diffs against previous state) ---
  // NOTE: this function only ever *writes* rows present in `updated` — it has
  // no way to notice rows that were removed (an empty/smaller array just
  // means nothing to write, so removed rows silently survive server-side).
  // Deletions must go through deleteAllQuestions/deleteQuestionsByIds below,
  // which issue explicit DELETE calls instead.
  //
  // Bug fix: this used to call a single .upsert(...) for every changed row.
  // Postgres implements upsert as INSERT ... ON CONFLICT DO UPDATE, and RLS
  // checks the INSERT policy for that statement even when it resolves to an
  // update on an existing row. Our INSERT policy is admin-only (uploads),
  // while UPDATE is allowed for any active user — so every validator edit
  // (claim, checklist, comments) was being rejected with "new row violates
  // row-level security policy for table questions", even though it was
  // really just an update. Splitting genuinely-new rows (insert) from
  // already-existing rows (update) routes each through the correct policy.
  // Bug fix (freeze on click, all question types): this used to detect changed
  // rows with JSON.stringify(prev) !== JSON.stringify(q) for every row in
  // `updated` — an O(size-of-object) deep-stringify per row, run synchronously
  // on the main thread on every single save. Every call site that builds
  // `updated` already preserves object identity for rows it doesn't touch
  // (e.g. `questions.map(q => q.id === id ? { ...q, ... } : q)` returns the
  // *same* object reference for every other row), so a reference-identity
  // check (`prev !== q`) is both correct and effectively free — no need to
  // walk/stringify passages, comment threads, or consensus review arrays at
  // all. This was the dominant cost behind the click-to-freeze symptom.
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
      ? supabase.from('questions').insert(newRows.map(questionToRow))
        .then(result => { releasePending(newRows); return result; })
      : null;

    // Bug fix (connection/rate-limit risk on large bulk actions): firing one
    // network request per changed row all at once via a single Promise.all
    // used to send hundreds/thousands of concurrent PATCH requests for a
    // large bulk approve/reject — that's also how many realtime echo events
    // land back on this client in one tight burst. Sending small batches and
    // awaiting each one before starting the next keeps the browser's
    // connection pool and PostgREST from being hammered all at once, without
    // changing the per-row update semantics (still routed through UPDATE,
    // not upsert, per the RLS note above).
    const WRITE_CHUNK_SIZE = 25;
    const runBatchedUpdates = async () => {
      const failures: { error: { message: string } }[] = [];
      for (let i = 0; i < existingRows.length; i += WRITE_CHUNK_SIZE) {
        const chunk = existingRows.slice(i, i + WRITE_CHUNK_SIZE);
        const results = await Promise.all(chunk.map(q =>
          supabase.from('questions').update(questionToRow(q)).eq('id', q.id)
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

  // --- "Wipe Workspace": Automatically exports all questions and data as JSON,
  // then clears local workspace state only without deleting database records. ---
  const deleteAllQuestions = async () => {
    if (questions.length > 0) {
      const exportList = questions.map(q => ({
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
      }));

      const blob = new Blob([JSON.stringify(exportList, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', url);
      downloadAnchor.setAttribute('download', `curation-workspace-auto-export-${Date.now()}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      setTimeout(() => {
        document.body.removeChild(downloadAnchor);
        URL.revokeObjectURL(url);
      }, 100);
      showToast(`Exported ${questions.length} question(s) before wiping workspace.`, 'success');
    }
    setQuestions([]);
    return true;
  };

  // --- Session logging helper: append-only insert into Supabase audit_log.
  // The local `logs` state updates via the realtime subscription above, so we
  // don't also splice it in here (avoids duplicate entries). ---
  const logEvent = (action: 'approve' | 'reject' | 'reset' | 'edit' | 'upload' | 'clear' | 'note' | 'check', description: string, questionId?: string) => {
    supabase.from('audit_log').insert({
      action,
      question_id: questionId || null,
      description,
      user_id: session?.user.id || null,
      user_name: validatorName
    }).then(({ error }) => {
      if (error) showToast(`Failed to write audit log: ${error.message}`, 'error');
    });
  };

  // --- Per-question revert history: fire-and-forget pre-action snapshot.
  // Mirrors the bulk_action_snapshots pattern used for the bulk toolbar
  // (see executeBulkConfirm below), but scoped to a single question and
  // triggered on every individual state-changing action, not just bulk
  // approve/reject. Deliberately non-blocking — these fire on routine things
  // like a single rubric checkbox toggle, so we don't want a network
  // round-trip to delay the click the way the bulk snapshot legitimately
  // does for a big, rarer batch action. If the insert fails, the action
  // still goes through (better to lose one history entry than to freeze
  // normal reviewing) but we surface a toast so it isn't silent. ---
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

  // Clears only the local view of the (shared, immutable) audit trail — the
  // Supabase record is untouched, and a refresh will bring it back.
  const handleClearLogs = () => {
    setLogs([]);
    showToast('Local view of the activity log cleared.', 'info');
  };

  // --- Validation Actions (spec §5): auto-derive overall status from the 4 checks ---
  // Any explicit "No" sends it to Needs Revision. All four checks passing does NOT
  // auto-approve on its own anymore — it only unlocks the explicit Approve button in
  // QuestionCard, and reviewStatus becomes 'approved' solely via handleApprove. A manual
  // statusOverride (with justification) always wins over the derived value.
  const deriveOverallStatus = (q: SATQuestion): 'pending' | 'approved' | 'rejected' | 'needs_revision' => {
    if (q.statusOverride) return q.statusOverride;
    const checks = [q.formationOk, q.answerOk, q.categoryOk, q.difficultyOk];
    if (checks.some(c => c === false)) return 'needs_revision';
    return 'pending';
  };

  // --- Action Handlers ---
  const handleApprove = (id: string) => {
    if (blockIfAuditor()) return;
    const question = questions.find(q => q.id === id);
    if (question) snapshotQuestionBeforeChange(question, 'approve');
    const updated = questions.map(q => q.id === id ? { ...q, reviewStatus: 'approved' as const } : q);
    saveQuestions(updated);
    showToast('Question item approved for test bank.', 'success');
    logEvent('approve', `Approved item "${id}" for the test bank in "${question?.category || 'General'}"`, id);
  };

  const handleReject = (id: string) => {
    if (blockIfAuditor()) return;
    const question = questions.find(q => q.id === id);
    if (question) snapshotQuestionBeforeChange(question, 'reject');
    const updated = questions.map(q => q.id === id ? { ...q, reviewStatus: 'rejected' as const } : q);
    saveQuestions(updated);
    showToast('Question item rejected.', 'info');
    logEvent('reject', `Rejected item "${id}" from test bank in "${question?.category || 'General'}"`, id);

    // Optional webhook back to the Generator agent (spec §13), fire-and-forget.
    if (settings.rejection_webhook_url) {
      fetch(settings.rejection_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: id,
          category: question?.category,
          reasons: (question?.comments || []).map(c => c.text),
          rejectedBy: validatorName,
          rejectedAt: new Date().toISOString()
        })
      }).catch(() => {
        showToast('Question rejected, but the rejection webhook call failed.', 'error');
      });
    }
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
    showToast('Question status and validation checklist reset to pending.', 'info');
    logEvent('reset', `Reset status of item "${id}" back to Pending review`, id);
  };

  // --- Validation Actions (spec §5): toggle independent Yes/No checks ---
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
    // Once approved, re-confirming a check that was already "Yes" shouldn't
    // silently revert the item to Pending — only an explicit "No" (which
    // deriveOverallStatus already routes to Needs Revision) should move it
    // off Approved after the fact.
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
      // Bug fix (no way to undo a check): a reset now sends value === null
      // here, which used to fall into the `: 'reject'` branch below and log
      // a false "marked as incorrect" audit entry. Give resets their own
      // neutral log entry instead.
      if (value === null) {
        logEvent(
          'reset',
          `Reset "${labels[field as keyof typeof labels]}" to unanswered on item "${id}" — overall status now ${derived.replace('_', ' ')}`,
          id
        );
        return;
      }
      // Bug fix (Daily Snapshot inflation): these are per-checkbox rubric
      // toggles, not whole-item decisions. Logging them as 'approve'/'reject'
      // made a single item review count as up to 4 extra approvals/rejections
      // in the Daily Snapshot tiles and per-validator table. Use a dedicated
      // 'check' action so only handleApprove/handleReject (real decisions)
      // contribute to those counts. See supabase/backfill_rubric_logs.sql for
      // the one-time relabel of historical rows logged before this fix.
      logEvent(
        'check',
        `Marked "${labels[field as keyof typeof labels]}" as ${value ? 'correct' : 'incorrect'} on item "${id}" — overall status now ${derived.replace('_', ' ')}`,
        id
      );
    });
  };

  // Reassigning the category also fixes the tag (marks the check as correct going forward)
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

  // Reassigning the difficulty also fixes the check (marks it as correct going forward)
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

  // Manual override of the auto-derived overall status — always requires a justification
  const handleManualOverride = (
    id: string,
    status: 'approved' | 'rejected' | 'needs_revision',
    justification: string
  ) => {
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

  // Drop a manual override and fall back to whatever the 4 checks derive to
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

  // --- Spec §6: append a threaded, timestamped, attributed comment to a question ---
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

    const updated = questions.map(q => q.id === id
      ? { ...q, comments: [...(q.comments || []), newComment] }
      : q
    );
    saveQuestions(updated);
    showToast('Comment added.', 'success');
    logEvent('note', `${newComment.author} commented on item "${id}": "${trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed}"`, id);
  };

  // --- Claim/lock (spec §3, §7): prevents two validators from reviewing the
  // same question at the same time.
  //
  // Bug fix: this used to check `question.claimedBy` against local React
  // state, then write with a plain upsert — both reads and the write raced
  // against whatever the *other* validator's browser was doing, so two
  // people clicking "claim" close together could both win. The fix below
  // makes the claim atomic at the database level: the UPDATE only succeeds
  // if claimed_by is still NULL at the moment Postgres applies it, and we
  // check `data` (the actual updated row(s), if any) to know whether we
  // really won the claim — not just whether the network call succeeded. ---
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
      .from('questions')
      .update({ claimed_by: session?.user.id || null, claimed_by_name: validatorName, claimed_at: claimedAt })
      .eq('id', id)
      .is('claimed_by', null) // <-- the atomic guard: only claims if still unclaimed server-side
      .select('id');

    // Release pending write
    const currentPending = (map.get(id) || 0) - 1;
    if (currentPending > 0) map.set(id, currentPending); else map.delete(id);

    if (error) {
      showToast(`Failed to claim: ${error.message}`, 'error');
      return;
    }
    if (!data || data.length === 0) {
      // Someone else's claim landed first between our read and this write.
      showToast('Someone just claimed this — refreshing.', 'error');
      refreshQuestionFromServer(id);
      return;
    }

    setQuestions(prev => prev.map(q => q.id === id
      ? { ...q, claimedBy: session?.user.id || null, claimedByName: validatorName, claimedAt }
      : q
    ));
    logEvent('edit', `${validatorName} claimed item "${id}" for review`, id);
  };

  // --- Helper for the claim race-guard above: re-pulls a single row from
  // Supabase so the UI reflects who actually won the claim, without waiting
  // on the realtime subscription. ---
  const refreshQuestionFromServer = async (id: string) => {
    const { data, error } = await supabase.from('questions').select('*').eq('id', id).single();
    if (!error && data) {
      const fresh = rowToQuestion(data as QuestionRow);
      setQuestions(prev => prev.map(q => q.id === id ? { ...q, ...fresh } : q));
    }
  };

  const handleReleaseClaim = (id: string) => {
    if (blockIfAuditor()) return;
    const updated = questions.map(q => q.id === id
      ? { ...q, claimedBy: null, claimedByName: null, claimedAt: null }
      : q
    );
    saveQuestions(updated);
    logEvent('edit', `${validatorName} released the claim on item "${id}"`, id);
  };

  // --- Admin-assigned queue (spec §3): distinct from self-serve claim above ---
  const handleAssignQuestion = (id: string, validatorId: string | null) => {
    if (blockIfAuditor()) return;
    if (!isAdmin) {
      showToast('Only admins can assign questions to validators.', 'error');
      return;
    }
    const target = validatorId ? validators.find(v => v.id === validatorId) : null;
    const updated = questions.map(q => q.id === id
      ? { ...q, assignedTo: validatorId, assignedToName: target?.name || null }
      : q
    );
    saveQuestions(updated);
    logEvent('edit', target
      ? `${validatorName} assigned item "${id}" to ${target.name}`
      : `${validatorName} unassigned item "${id}"`, id);
  };

  // --- Second-reviewer / consensus mode (spec §7) ---
  const handleSubmitConsensusReview = (id: string, checks: { formationOk: boolean | null; answerOk: boolean | null; categoryOk: boolean | null; difficultyOk: boolean | null }) => {
    if (blockIfAuditor()) return;
    if (!session) return;
    const question = questions.find(q => q.id === id);
    if (!question) return;

    // The person who claimed the question already did the primary review
    // (the 4-check checklist above). Second opinions must come from other
    // validators, so the primary reviewer can't also review themselves.
    if (question.claimedBy && question.claimedBy === session.user.id) {
      showToast("You're the primary reviewer on this item — second opinions must come from other validators.", 'error');
      return;
    }

    const existing = question.consensusReviews || [];
    const withoutMine = existing.filter(r => r.validatorId !== session.user.id);

    // Cap at MAX_CONSENSUS_REVIEWERS distinct "second opinion" validators.
    // Updating your own existing review is always allowed; only *new*
    // validators are blocked once the cap is reached.
    const isNewReviewer = withoutMine.length === existing.length; // i.e. I wasn't in the list before
    if (isNewReviewer && withoutMine.length >= MAX_CONSENSUS_REVIEWERS) {
      showToast(`This question already has ${MAX_CONSENSUS_REVIEWERS} independent second opinions.`, 'error');
      return;
    }

    const myReview = {
      validatorId: session.user.id,
      validatorName,
      ...checks,
      timestamp: new Date().toISOString()
    };

    const updated = questions.map(q => q.id === id
      ? { ...q, consensusReviews: [...withoutMine, myReview] }
      : q
    );
    saveQuestions(updated);
    showToast('Independent consensus review submitted.', 'success');
    logEvent('note', `${validatorName} submitted an independent consensus review on item "${id}"`, id);
  };

  // --- Admin resolution of a primary vs. second-opinion disagreement ---
  // When the primary reviewer's checklist verdict conflicts with the
  // majority verdict from the (up to 3) independent second opinions, an
  // admin picks a side. Under the hood this is the same mechanism as a
  // validator's manual status override (statusOverride + justification),
  // so it's fully visible/reversible from the "Manual Status Override"
  // section too, and always writes an explicit audit log entry.
  const handleResolveConsensus = (id: string, resolution: 'primary' | 'second_opinion') => {
    if (blockIfAuditor()) return;
    if (!isAdmin) {
      showToast('Only admins can resolve primary vs. second-opinion disagreements.', 'error');
      return;
    }
    const question = questions.find(q => q.id === id);
    if (!question) return;
    snapshotQuestionBeforeChange(question, 'resolve_consensus');

    const { primaryVerdict, secondOpinionVerdict, secondOpinionApproved, secondOpinionNeedsRevision, hasDisagreement } =
      getConsensusResolution(question);

    if (!hasDisagreement || !secondOpinionVerdict || primaryVerdict === 'pending') {
      showToast('There is no active primary vs. second-opinion disagreement on this item.', 'error');
      return;
    }

    // hasDisagreement guarantees both verdicts are decisive ('approved' | 'needs_revision'),
    // never 'pending' — narrow explicitly so this matches statusOverride's type.
    const finalStatus: 'approved' | 'needs_revision' =
      resolution === 'primary' ? (primaryVerdict as 'approved' | 'needs_revision') : (secondOpinionVerdict as 'approved' | 'needs_revision');
    const justification = resolution === 'primary'
      ? `Admin kept the primary reviewer's verdict ("${primaryVerdict.replace('_', ' ')}") over ${secondOpinionApproved + secondOpinionNeedsRevision} second opinions (${secondOpinionApproved} approved / ${secondOpinionNeedsRevision} needs revision).`
      : `Admin applied the second-opinion consensus ("${secondOpinionVerdict.replace('_', ' ')}", ${secondOpinionApproved} approved / ${secondOpinionNeedsRevision} needs revision) over the primary reviewer's verdict ("${primaryVerdict.replace('_', ' ')}").`;

    const updated = questions.map(q => q.id === id ? {
      ...q,
      statusOverride: finalStatus,
      statusOverrideJustification: justification,
      reviewStatus: finalStatus
    } : q);
    saveQuestions(updated);
    showToast(`Disagreement resolved — status set to "${finalStatus.replace('_', ' ')}".`, 'success');
    logEvent(
      finalStatus === 'approved' ? 'approve' : 'edit',
      `${validatorName} (admin) resolved a primary vs. second-opinion disagreement on item "${id}" — sided with ${resolution === 'primary' ? "the primary reviewer" : "the second opinions"}. ${justification}`,
      id
    );
  };

  // --- Point 6: open the side-by-side duplicate comparison for a flagged item ---
  const handleViewDuplicate = (question: SATQuestion) => {
    setDuplicateCompareQuestion(question);
  };

  const handleEditTrigger = (q: SATQuestion) => {
    setSelectedEditQuestion(q);
    setIsEditModalOpen(true);
  };

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
      showToast('Only admins can clear the workspace.', 'error');
      return;
    }
    setClearConfirmTypedText('');
    setIsClearConfirmOpen(true);
  };

  // --- Bulk Action Handlers (act on currently filtered questions only) ---
  // These no longer write directly — they open a confirmation modal first.
  // The actual write happens in executeBulkConfirm, after a pre-action
  // snapshot of exactly these ids has been saved (see below).
  const handleApproveAllFiltered = () => {
    if (blockIfAuditor()) return;
    const idsToApprove = filteredQuestions.map(q => q.id);
    if (idsToApprove.length === 0) {
      showToast('No filtered questions to approve.', 'error');
      return;
    }
    setBulkConfirmTypedText('');
    setBulkConfirm({ actionType: 'approve_filtered', status: 'approved', ids: idsToApprove });
  };

  const handleRejectAllFiltered = () => {
    if (blockIfAuditor()) return;
    const idsToReject = filteredQuestions.map(q => q.id);
    if (idsToReject.length === 0) {
      showToast('No filtered questions to reject.', 'error');
      return;
    }
    setBulkConfirmTypedText('');
    setBulkConfirm({ actionType: 'reject_filtered', status: 'rejected', ids: idsToReject });
  };

  const BULK_ACTION_LOG_DESCRIPTIONS: Record<BulkActionType, (n: number) => string> = {
    approve_filtered: n => `Bulk approved ${n} filtered item(s)`,
    reject_filtered: n => `Bulk rejected ${n} filtered item(s)`,
    approve_selected: n => `Bulk approved ${n} manually selected item(s)`,
    reject_selected: n => `Bulk rejected ${n} manually selected item(s)`
  };

  // Saves a pre-action snapshot of exactly `ids`, then applies the status
  // change. If the snapshot write fails, the action is aborted rather than
  // applied un-recoverably.
  const executeBulkConfirm = async () => {
    if (!bulkConfirm) return;
    const { actionType, status, ids } = bulkConfirm;
    setIsSubmittingBulk(true);

    const snapshotRows = questions.filter(q => ids.includes(q.id));
    const { data: snapRow, error: snapError } = await supabase
      .from('bulk_action_snapshots')
      .insert({
        action_type: actionType,
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

    if (actionType === 'approve_selected' || actionType === 'reject_selected') {
      setSelectedIds(new Set());
    }

    setLastBulkSnapshot({
      id: snapRow.id,
      action_type: snapRow.action_type,
      performed_by_name: snapRow.performed_by_name,
      created_at: snapRow.created_at,
      snapshot: snapshotRows
    });

    setBulkConfirm(null);
    setIsSubmittingBulk(false);
  };

  // Restores exactly the questions captured in the last bulk snapshot to
  // exactly what they looked like beforehand — never touches any other
  // question, so it can't repeat the earlier incident where a manual reset
  // accidentally reverted pre-existing approvals along with the bad batch.
  const handleUndoLastBulkAction = async () => {
    if (!lastBulkSnapshot) return;
    if (blockIfAuditor()) return;
    setIsUndoingBulk(true);

    const snapshotQuestions = lastBulkSnapshot.snapshot;
    const snapshotMap = new Map(snapshotQuestions.map(q => [q.id, q]));
    const restored = questions.map(q => snapshotMap.has(q.id) ? snapshotMap.get(q.id)! : q);
    saveQuestions(restored);
    logEvent(
      'reset',
      `Undid bulk action "${lastBulkSnapshot.action_type}" (by ${lastBulkSnapshot.performed_by_name || 'unknown'}) — restored ${snapshotQuestions.length} item(s) to their exact prior state`
    );

    const { error } = await supabase
      .from('bulk_action_snapshots')
      .update({ undone: true, undone_at: new Date().toISOString() })
      .eq('id', lastBulkSnapshot.id);
    if (error) {
      showToast(`Restored locally, but failed to mark the snapshot as undone: ${error.message}`, 'error');
    } else {
      showToast(`Restored ${snapshotQuestions.length} question(s) to their state before that bulk action.`, 'info');
    }

    setLastBulkSnapshot(null);
    setIsUndoingBulk(false);
    refreshLastBulkSnapshot();
  };

  // --- Per-question revert: restores one question to an exact snapshot from
  // its history (see QuestionHistoryDrawer). Admin-only, and enforced both
  // here and at the DB level (question_snapshots UPDATE policy) — the person
  // who caused the mistake isn't necessarily the right person to silently
  // erase it, so this is scoped to admins the same way the plan called for.
  // Field-by-field restore, same precise approach as handleUndoLastBulkAction
  // above — never a blanket reset of the question. Doesn't delete or alter
  // any other snapshot in the timeline, so if this restore itself turns out
  // wrong, admin can just pick a different point in the same history. ---
  const handleRestoreQuestionSnapshot = async (snap: QuestionSnapshot) => {
    if (blockIfAuditor()) return false;
    if (!isAdmin) {
      showToast('Only admins can restore a question to a past state.', 'error');
      return false;
    }
    const restoredQuestion = snap.snapshot;
    const updated = questions.map(q => q.id === restoredQuestion.id ? restoredQuestion : q);
    saveQuestions(updated);
    logEvent(
      'reset',
      `Admin ${validatorName} restored item "${restoredQuestion.id}" to its state from before a "${snap.action_type}" action (snapshot taken ${new Date(snap.created_at).toLocaleString()}, originally by ${snap.performed_by_name || 'unknown'})`,
      restoredQuestion.id
    );

    const { error } = await supabase
      .from('question_snapshots')
      .update({ restored: true })
      .eq('id', snap.id);
    if (error) {
      showToast(`Restored locally, but failed to mark the snapshot as restored: ${error.message}`, 'error');
    } else {
      showToast(`Restored item "${restoredQuestion.id}" to its state from before that action.`, 'info');
    }
    return true;
  };

  // --- Custom Selection Handlers (reviewer picks specific questions, any mix) ---
  const handleToggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const updated = new Set(prev);
      if (updated.has(id)) {
        updated.delete(id);
      } else {
        updated.add(id);
      }
      return updated;
    });
  };

  const handleSelectAllVisible = () => {
    setSelectedIds(new Set(filteredQuestions.map(q => q.id)));
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleApproveSelected = () => {
    if (blockIfAuditor()) return;
    if (selectedIds.size === 0) {
      showToast('No questions selected.', 'error');
      return;
    }
    setBulkConfirmTypedText('');
    setBulkConfirm({ actionType: 'approve_selected', status: 'approved', ids: Array.from(selectedIds) });
  };

  const handleRejectSelected = () => {
    if (blockIfAuditor()) return;
    if (selectedIds.size === 0) {
      showToast('No questions selected.', 'error');
      return;
    }
    setBulkConfirmTypedText('');
    setBulkConfirm({ actionType: 'reject_selected', status: 'rejected', ids: Array.from(selectedIds) });
  };

  // --- File Upload Logic (point 7: supports selecting/dropping multiple export files at once) ---
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (blockIfAuditor()) return;
    if (!isAdmin) {
      showToast('Only admins can upload JSON files.', 'error');
      return;
    }
    const files = e.target.files;
    if (!files || files.length === 0) return;
    readFiles(Array.from(files));
    e.target.value = ''; // Reset input value so the same file(s) can be uploaded again!
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (blockIfAuditor()) return;
    if (!isAdmin) {
      showToast('Only admins can upload JSON files.', 'error');
      return;
    }
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      readFiles(Array.from(files));
    }
  };

  // Sanitize a single raw parsed question object into our internal SATQuestion shape
  // Deterministic ~N% sample for second-reviewer/consensus mode (spec §7), based
  // on a stable hash of the question id so the same items are always sampled.
  const isInConsensusSample = (id: string, rate: number): boolean => {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    }
    return (hash % 100) < Math.round(rate * 100);
  };

  const sanitizeQuestion = (q: any, idx: number): SATQuestion => {
    // Bug fix: the fallback id used to be computed twice — once here, once
    // again inside the requiresSecondReview default further down — via two
    // separate Date.now() calls. If those straddled a millisecond boundary,
    // the consensus-sample hash was computed against a different string than
    // the id actually persisted, silently breaking the "stable hash of the
    // question id" guarantee. Compute it once and reuse it everywhere.
    const fallbackId = `curated-sat-${Date.now()}-${idx + 1}`;
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
    // Spec §6: prefer an existing `comments` thread; otherwise migrate a legacy
    // single reviewerNote string into a one-entry thread so nothing is lost.
    comments: Array.isArray(q.comments)
      ? q.comments
      : (q.reviewerNote || q.reviewer_note)
        ? [{
          id: `comment-imported-${idx}`,
          text: q.reviewerNote || q.reviewer_note,
          timestamp: q.createdAt || new Date().toISOString(),
          author: 'Imported'
        }]
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

  // Reads one File and resolves with its sanitized questions (or rejects with a readable error)
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

  // Reads one or more selected/dropped files, then merges all of them (plus whatever
  // is already loaded in the workspace) into a single review session, deduped by id.
  const readFiles = async (files: File[]) => {
    const jsonFiles = files.filter(f => f.name.toLowerCase().endsWith('.json'));
    if (jsonFiles.length === 0) {
      showToast('No .json files found in your selection/drop.', 'error');
      return;
    }

    const results = await Promise.allSettled(jsonFiles.map(parseQuestionFile));

    const succeeded = results.filter(
      (r): r is PromiseFulfilledResult<{ file: string; sanitized: SATQuestion[] }> => r.status === 'fulfilled'
    );
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    if (succeeded.length === 0) {
      showToast(failed.length > 0 ? String(failed[0].reason) : 'Failed to load any files.', 'error');
      return;
    }

    // Merge into a single deduped-by-id list. Existing workspace items are preserved
    // unless a newly-loaded file contains the same id, in which case the newer
    // version (later file wins on collisions across files too) overrides it.
    const merged = new Map<string, SATQuestion>();
    questions.forEach(q => merged.set(q.id, q));

    let incomingCount = 0;
    let updatedCount = 0;
    succeeded.forEach(({ value }) => {
      value.sanitized.forEach(q => {
        if (merged.has(q.id)) {
          updatedCount++;
        } else {
          incomingCount++;
        }
        merged.set(q.id, q);
      });
    });

    const mergedList = Array.from(merged.values());
    saveQuestions(mergedList);

    const fileNames = succeeded.map(s => s.value.file).join(', ');
    const summary = `Merged ${succeeded.length} file(s) [${fileNames}] — ${incomingCount} new item(s), ${updatedCount} updated by id. Workspace now has ${mergedList.length} total.`;
    logEvent('upload', summary);

    if (failed.length > 0) {
      const failureReasons = failed.map(f => String(f.reason)).join(' ');
      showToast(`${summary} ⚠️ ${failed.length} file(s) failed: ${failureReasons}`, 'info');
    } else {
      showToast(summary, 'success');
    }
  };

  // --- Navigation filtering callback ---
  const handleSelectSubdomainFilter = (category: string, value: string, groupingKey: string) => {
    const updates: Partial<FilterState> = {
      category: category,
      search: ''
    };

    if (groupingKey === 'difficulty') {
      updates.difficulty = value.toLowerCase();
    } else {
      // Put value in search filter for standard matching
      updates.search = value;
    }

    setFilters(prev => ({ ...prev, ...updates }));
    setActiveTab('curator');
    showToast(`Navigated to deck filtered by Domain "${category}" & ${groupingKey} "${value}"`, 'info');
  };

  // --- Distinct "production question bank" export (spec §10, §12, §13) ---
  // Unmodified — kept exactly as-is per explicit request when the export
  // dropdown below was introduced. Unlike the bucketed exports below (which
  // round-trip the app's own internal shape, filtered/flattened per status),
  // this maps approved questions to the spec's production data model — the
  // format MySAT AI Coach's production bank is meant to consume.
  const downloadProductionBank = () => {
    if (!isAdmin) {
      showToast('Only admins can export questions.', 'error');
      return;
    }
    const approved = questions.filter(q => q.reviewStatus === 'approved');
    if (approved.length === 0) {
      showToast('No approved questions yet — approve some before exporting the production bank.', 'error');
      return;
    }

    const productionRecords = approved.map(q => ({
      id: q.id,
      stem: q.question,
      question_type: q.questionType || 'mcq',
      choices: q.choices,
      correct_answer: q.correct_answer,
      explanation: q.explanation,
      category: q.category,
      sub_skill: q.subSkill || null,
      difficulty: q.difficulty,
      passage: q.passage,
      stimulus: q.stimulus || null,
      image_url: q.imageUrl || null,
      generator_run_id: q.generatorRunId || null,
      status: 'validated',
      validated_at: new Date().toISOString(),
      created_at: q.createdAt || null
    }));

    const blob = new Blob([JSON.stringify(productionRecords, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', url);
    downloadAnchor.setAttribute('download', `mysat-production-question-bank-${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    setTimeout(() => {
      document.body.removeChild(downloadAnchor);
      URL.revokeObjectURL(url);
    }, 100);

    showToast(`Exported ${productionRecords.length} validated question(s) in production bank format.`, 'success');
    logEvent('note', `Exported ${productionRecords.length} question(s) to the production question bank format`);
  };

  // --- Bucketed exports (Approved / Rejected / Needs Revision / Total Test
  // Bank), each available as JSON or Excel from the "Export" dropdown.
  // Replaces the old separate "Export Test Bank" / "Export Excel" /
  // "Export Rejected" buttons — Export Production Bank above is untouched.
  type ExportBucket = 'approved' | 'rejected' | 'needs_revision' | 'all';

  const EXPORT_BUCKET_LABELS: Record<ExportBucket, string> = {
    approved: 'Approved Questions',
    rejected: 'Rejected Questions',
    needs_revision: 'Needs Revision Questions',
    all: 'Total Test Bank'
  };

  const EXPORT_BUCKET_FILENAMES: Record<ExportBucket, string> = {
    approved: 'approved-questions',
    rejected: 'rejected-questions',
    needs_revision: 'needs-revision-questions',
    all: 'total-test-bank'
  };

  const questionsInBucket = (bucket: ExportBucket) =>
    bucket === 'all' ? questions : questions.filter(q => (q.reviewStatus || 'pending') === bucket);

  // One record shape shared by all 4 buckets and both output formats, so
  // "Total Test Bank" isn't a special case — it's just the 'all' bucket
  // through the same builder. Includes the full question content, the
  // review checklist + overrides, comments, consensus reviews,
  // claim/assignment info, and the pipeline's own validator verdict.
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

  const copyCurationToClipboard = () => {
    if (!isAdmin) {
      showToast('Only admins can export questions.', 'error');
      return;
    }
    const approved = questions.filter(q => q.reviewStatus === 'approved');
    if (approved.length === 0) {
      showToast('Please approve some items to copy first.', 'error');
      return;
    }
    // Strip transient UI-only properties to match the exact original format
    const cleanApproved = approved.map(({ reviewStatus, ...rest }) => rest);
    // Bug fix: this write was unguarded, so a denied clipboard permission
    // (common in non-HTTPS/iframe contexts) failed silently — the success
    // toast fired regardless of whether the copy actually worked.
    navigator.clipboard.writeText(JSON.stringify(cleanApproved, null, 2))
      .then(() => showToast('Copied approved questions payload directly to your clipboard in original JSON format!', 'success'))
      .catch(() => showToast('Could not copy to clipboard — your browser may be blocking clipboard access.', 'error'));
  };

  // --- Dynamic Stats Engine ---
  // Bug fix (freeze on click — affected every question, not just Math ones):
  // this whole block (stats, unique category/section lists, filtering, and
  // sorting) used to be plain `const`s recomputed on *every* render of App.
  // Any click on any question card (approve, a checklist toggle, adding a
  // comment, claiming) calls setQuestions(), which re-renders App, which
  // re-ran a full filter + sort + stats pass over the *entire* workspace —
  // cost scales with total question/log count, not with which question was
  // clicked, which is why it got worse the longer a session ran regardless
  // of question type (Math or English). Memoizing each stage so it only
  // recomputes when its actual inputs change removes that per-click cost.
  const stats: StatsSummary = useMemo(() => {
    const s: StatsSummary = {
      total: questions.length,
      pending: 0,
      approved: 0,
      rejected: 0,
      needsRevision: 0,
      bySection: {},
      byDifficulty: { easy: 0, medium: 0, hard: 0 },
      byCategory: {}
    };

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

  // Extract list of all unique categories and sections present for dropdown filters
  const uniqueCategories = useMemo(
    () => Array.from(new Set<string>(questions.map(q => q.category as string))).sort(),
    [questions]
  );
  const uniqueSections = useMemo(
    () => Array.from(new Set<string>(questions.map(q => (q.Section || q.section || 'Reading_Writing') as string))).sort(),
    [questions]
  );

  // --- Filter Evaluation Engine ---
  const filteredQuestions = useMemo(() => questions.filter(q => {
    // 1. Text Search matches id, question, passage, stimulus, explanation
    const matchText = filters.search.toLowerCase();
    const searchMatch = !matchText ||
      q.id.toLowerCase().includes(matchText) ||
      q.question.toLowerCase().includes(matchText) ||
      (q.passage && q.passage.toLowerCase().includes(matchText)) ||
      (q.stimulus && q.stimulus.toLowerCase().includes(matchText)) ||
      (q.explanation && q.explanation.toLowerCase().includes(matchText));

    // 2. Section selector Match
    const sectionVal = q.Section || q.section || 'Reading_Writing';
    const sectionMatch = !filters.section || sectionVal === filters.section;

    // 3. Category selector Match
    const categoryMatch = !filters.category || q.category === filters.category;

    // 4. Difficulty selector Match
    const difficultyMatch = !filters.difficulty || (q.difficulty || '').toLowerCase() === filters.difficulty.toLowerCase();

    // 5. Status Card filter
    let statusMatch = true;
    if (filters.status === 'approved') {
      statusMatch = q.reviewStatus === 'approved';
    } else if (filters.status === 'rejected') {
      statusMatch = q.reviewStatus === 'rejected';
    } else if (filters.status === 'pending') {
      statusMatch = !q.reviewStatus || q.reviewStatus === 'pending';
    } else if (filters.status === 'needs_revision') {
      statusMatch = q.reviewStatus === 'needs_revision';
    }

    // 6. Generator run ID (spec §3)
    const runIdMatch = !filters.generatorRunId || (q.generatorRunId || '').toLowerCase().includes(filters.generatorRunId.toLowerCase());

    // 7. Assigned/claimed validator (spec §3)
    const assignedMatch = !filters.assignedOrClaimedBy ||
      q.assignedTo === filters.assignedOrClaimedBy ||
      q.claimedBy === filters.assignedOrClaimedBy;

    // 8. Date generated range (spec §3)
    let dateMatch = true;
    if ((filters.dateFrom || filters.dateTo) && q.createdAt) {
      const created = new Date(q.createdAt).getTime();
      if (filters.dateFrom) dateMatch = dateMatch && created >= new Date(filters.dateFrom).getTime();
      if (filters.dateTo) dateMatch = dateMatch && created <= new Date(filters.dateTo).getTime() + 86400000;
    }

    return searchMatch && sectionMatch && categoryMatch && difficultyMatch && statusMatch && runIdMatch && assignedMatch && dateMatch;
  }), [questions, filters]);

  // --- Sort control (spec §3: "Filter/sort by ... date generated ...") ---
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

  // --- Pagination (spec §3, §11: queue supports 10k+ questions without degradation) ---
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  useEffect(() => {
    setCurrentPage(1);
  }, [filters, questions.length]);
  const totalPages = Math.max(1, Math.ceil(filteredQuestions.length / pageSize));
  const pageSafe = Math.min(currentPage, totalPages);
  const paginatedQuestions = useMemo(
    () => sortedQuestions.slice((pageSafe - 1) * pageSize, pageSafe * pageSize),
    [sortedQuestions, pageSafe, pageSize]
  );

  // Bug fix (freeze on click — reproduced on English questions too, not just
  // Math): each visible QuestionCard used to be handed
  // `logs.filter(l => l.questionId === question.id)` inline in the .map()
  // below — an O(logs.length) scan of the *entire* audit trail, repeated for
  // every card on the page, on every render. That cost has nothing to do
  // with question content/type, which is why it showed up across the board.
  // Grouping once into a Map keyed by question id turns each card's lookup
  // into an O(1) array access, and only rebuilds when `logs` actually changes.
  const logsByQuestionId = useMemo(() => {
    const map = new Map<string, AuditLogEntry[]>();
    for (const l of logs) {
      if (!l.questionId) continue;
      const bucket = map.get(l.questionId);
      if (bucket) bucket.push(l);
      else map.set(l.questionId, [l]);
    }
    return map;
  }, [logs]);

  const reviewedCount = stats.approved + stats.rejected;
  const reviewProgressPct = stats.total === 0 ? 0 : Math.round((reviewedCount / stats.total) * 100);

  const hasActiveFilters = !!(filters.search || filters.section || filters.category || filters.difficulty || filters.status !== 'all' || filters.generatorRunId || filters.assignedOrClaimedBy || filters.dateFrom || filters.dateTo);

  const handleResetFilters = () => {
    setFilters({
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
    showToast('All search and dropdown filters cleared.', 'info');
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#e8eaf6] flex items-center justify-center text-zinc-500 text-sm">
        Loading…
      </div>
    );
  }

  if (passwordRecovery) {
    return <UpdatePassword onDone={() => setPasswordRecovery(false)} />;
  }

  if (!session) {
    return <Login initialError={authLinkError} initialMode={authLinkError ? 'forgot' : 'signin'} />;
  }

  if (pendingApproval) {
    return (
      <div className="min-h-screen bg-[#e8eaf6] flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-6 text-center">
          <div className="w-10 h-10 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-700 mx-auto mb-4">
            <Clock className="w-5 h-5" />
          </div>
          <h1 className="text-sm font-bold text-zinc-900 mb-1.5">Your account is pending approval</h1>
          <p className="text-xs text-zinc-500 leading-relaxed mb-5">
            {session.user.email} signed up but wasn't pre-invited by an admin. Ask an admin to approve your account from
            the Admin tab, or to send you an invite so you're auto-activated next time.
          </p>
          <button
            onClick={handleSignOut}
            className="w-full py-2.5 text-xs font-bold rounded-lg bg-[#f2f2f3] border border-[#e4e4e7] text-zinc-600 hover:bg-[#e4e4e7] transition-all cursor-pointer"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#e8eaf6] pb-20 text-zinc-900 selection:bg-[#6366f1] selection:text-white font-sans antialiased">

      {/* Sticky Header Cockpit */}
      <header className="sticky top-0 z-40 bg-[#e8eaf6] border-b border-[#e4e4e7] select-none">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-8.5 h-8.5 rounded-lg bg-[#ececed] border border-[#e4e4e7] flex items-center justify-center text-[#4f46e5]">
              <Layers className="w-4 h-4" />
            </span>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-zinc-900">SAT Test Bank Curation Portal</h1>
              <p className="text-[12px] text-zinc-500 font-medium">Official Audit &amp; Approval Console</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Authenticated validator identity (spec §2): real Supabase account,
                attributes comments & audit log entries. */}
            <div
              className="flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 border border-[#e4e4e7] rounded-lg bg-[#fafafa]"
              title={session?.user.email}
            >
              <User className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              <span className="text-xs text-zinc-700 max-w-30 truncate">{validatorName}</span>
              {isAdmin && (
                <span className="flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-200">
                  <ShieldCheck className="w-2.5 h-2.5" /> ADMIN
                </span>
              )}
            </div>

            <button
              onClick={handleSignOut}
              title="Sign out"
              className="p-2 text-zinc-500 hover:text-zinc-900 border border-[#e4e4e7] hover:bg-[#f2f2f3] rounded-lg transition-all cursor-pointer bg-[#fafafa]"
            >
              <LogOut className="w-4 h-4" />
            </button>

            {/* Exports are an admin-only action — validators/auditors never see these */}
            {isAdmin && (
              <>
                <span className="h-4 w-px bg-[#e4e4e7] mx-1" />

                {/* Distinct production question bank export (spec §10, §12, §13) — untouched */}
                <button
                  onClick={downloadProductionBank}
                  disabled={stats.approved === 0}
                  title="Export approved questions in the production data model MySAT AI Coach consumes"
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer ${stats.approved === 0
                      ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed'
                      : 'bg-emerald-700 hover:bg-emerald-600 text-white border-emerald-700 shadow-xs'
                    }`}
                >
                  <Download className="w-3.5 h-3.5" />
                  Export Production Bank
                </button>

                {/* Bucketed export dropdown: Approved / Rejected / Needs Revision /
                    Total Test Bank, each as JSON or Excel — replaces the old
                    separate Export Test Bank / Export Excel / Export Rejected buttons. */}
                <div className="relative" ref={exportMenuRef}>
                  <button
                    onClick={() => setIsExportMenuOpen(open => !open)}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer bg-[#6366f1] hover:bg-indigo-700 text-white border-[#6366f1] shadow-xs"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExportMenuOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {isExportMenuOpen && (
                    <div className="absolute right-0 mt-1.5 w-88 bg-white border border-[#e4e4e7] rounded-xl shadow-2xl z-30 overflow-hidden">
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

                <span className="h-4 w-px bg-[#e4e4e7] mx-1" />

                {/* Admin-only "Start Fresh" action — deliberately placed at the
                    far end of the toolbar, away from Sign Out, so it can't be
                    clicked by mistake while reaching for that button. */}
                <button
                  onClick={handleClearAllQuestions}
                  title="Clear current workspace items (admin only)"
                  className="p-2 text-zinc-500 hover:text-rose-600 border border-[#e4e4e7] hover:bg-rose-50 rounded-lg transition-all cursor-pointer bg-[#fafafa]"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Body Grid */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">

        {/* Banner callout */}
        <div className="mb-6 bg-linear-to-r from-[#fafafa] to-[#f2f2f3] text-zinc-900 rounded-2xl p-6 relative overflow-hidden flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border border-[#e4e4e7] shadow-sm">
          <div className="relative z-10 space-y-1">
            <h2 className="text-base font-bold tracking-tight">Curation Action Center</h2>
            <p className="text-xs text-zinc-500 font-normal leading-relaxed max-w-xl">
              Audit questions, make inline corrections to text, and determine whether items are included in the official test bank. Upload questions directly via dragging one or more JSON files or download your approved curation below.
            </p>
          </div>

          <div className="relative z-10 flex gap-2 w-full md:w-auto">
            {/* Uploading JSON banks is an admin-only action */}
            {isAdmin && (
              <>
                {/* hidden file trigger */}
                <input
                  type="file"
                  accept=".json"
                  multiple
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  className="hidden"
                />

                <button
                  onClick={() => fileInputRef.current?.click()}
                  title="Select one or more JSON export files — they'll be merged into this session"
                  className="flex-1 md:flex-none flex items-center justify-center gap-1.5 px-4 py-2.5 bg-[#ececed] hover:bg-[#e4e4e7] text-zinc-900 text-xs font-bold rounded-xl border border-[#e4e4e7] transition-all cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-zinc-600" /> Upload / Merge JSON Bank(s)
                </button>
              </>
            )}

            <button
              onClick={() => setActiveTab('audit')}
              className="flex-1 md:flex-none flex items-center justify-center gap-1.5 px-4 py-2.5 bg-[#fafafa] hover:bg-[#f2f2f3] text-zinc-700 text-xs font-bold rounded-xl border border-[#e4e4e7] transition-all cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5 text-zinc-500" /> Audit Trail Log
            </button>
          </div>
        </div>

        {/* Drag-over area overlay indicator — uploads are admin-only, so validators/auditors don't get a target */}
        {isAdmin && (
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`transition-all rounded-2xl border-2 border-dashed flex flex-col items-center justify-center p-8 mb-6 ${dragOver
                ? 'border-[#6366f1] bg-[#f2f2f3]/50 py-12 scale-[0.99] text-[#4f46e5] shadow-inner'
                : 'border-[#e4e4e7] bg-transparent py-4 text-zinc-500'
              }`}
          >
            <div className="flex flex-col sm:flex-row items-center gap-3">
              <Upload className={`w-5 h-5 ${dragOver ? 'text-[#4f46e5] animate-bounce' : 'text-zinc-500'}`} />
              <p className="text-xs font-medium text-center">
                {dragOver
                  ? 'Drop one or more SAT questions JSON files here to merge them in immediately!'
                  : 'Drag and drop one or more compatible SAT JSON files onto this panel — they will be merged into a single review session.'}
              </p>
            </div>
          </div>
        )}

        {/* Workspace Windows and Navigation Tabs Selection Bar */}
        <div className="flex border-b border-[#e4e4e7] mb-6 gap-2 select-none overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveTab('curator')}
            className={`px-4 py-2.5 text-xs font-bold transition-all flex items-center gap-1.5 border-b-2 cursor-pointer whitespace-nowrap shrink-0 ${activeTab === 'curator'
                ? 'border-[#6366f1] text-[#4f46e5]'
                : 'border-transparent text-zinc-500 hover:text-zinc-900'
              }`}
          >
            <Layers className="w-3.5 h-3.5 text-[#4f46e5]" />
            Curation Feed
          </button>

          <button
            onClick={() => setActiveTab('newbatch')}
            className={`px-4 py-2.5 text-xs font-bold transition-all flex items-center gap-1.5 border-b-2 cursor-pointer whitespace-nowrap shrink-0 ${activeTab === 'newbatch'
                ? 'border-[#6366f1] text-[#4f46e5]'
                : 'border-transparent text-zinc-500 hover:text-zinc-900'
              }`}
          >
            <Upload className="w-3.5 h-3.5 text-[#4f46e5]" />
            New Batch
          </button>

          <button
            onClick={() => setActiveTab('analytics')}
            className={`px-4 py-2.5 text-xs font-bold transition-all flex items-center gap-1.5 border-b-2 cursor-pointer whitespace-nowrap shrink-0 ${activeTab === 'analytics'
                ? 'border-[#6366f1] text-[#4f46e5]'
                : 'border-transparent text-zinc-500 hover:text-zinc-900'
              }`}
          >
            <PieChart className="w-3.5 h-3.5 text-[#4f46e5]" />
            Domain &amp; Sub-domain breakdown
          </button>

          <button
            onClick={() => setActiveTab('audit')}
            className={`px-4 py-2.5 text-xs font-bold transition-all flex items-center gap-1.5 border-b-2 cursor-pointer whitespace-nowrap shrink-0 ${activeTab === 'audit'
                ? 'border-[#6366f1] text-[#4f46e5]'
                : 'border-transparent text-zinc-500 hover:text-zinc-900'
              }`}
          >
            <History className="w-3.5 h-3.5 text-[#4f46e5]" />
            Live Audit Trail History
          </button>

          {isAdmin && (
            <button
              onClick={() => setActiveTab('admin')}
              className={`px-4 py-2.5 text-xs font-bold transition-all flex items-center gap-1.5 border-b-2 cursor-pointer whitespace-nowrap shrink-0 ${activeTab === 'admin'
                  ? 'border-[#6366f1] text-[#4f46e5]'
                  : 'border-transparent text-zinc-500 hover:text-zinc-900'
                }`}
            >
              <ShieldCheck className="w-3.5 h-3.5 text-[#4f46e5]" />
              Admin
            </button>
          )}
        </div>

        {/* Render workspaces conditionally based on activeTab state */}
        {activeTab === 'newbatch' && (
          <NewBatchWorkspace
            session={session as Session}
            validatorName={validatorName}
            isAdmin={isAdmin}
            isAuditor={isAuditor}
            validators={validators}
            settings={settings}
            logs={logs}
            showToast={showToast}
          />
        )}

        {activeTab === 'analytics' && (
          <DomainAnalytics
            questions={questions}
            onSelectSubdomainFilter={handleSelectSubdomainFilter}
          />
        )}

        <div className={activeTab === 'audit' ? 'block' : 'hidden'}>
          <AuditActivityLogs
            logs={logs}
            onClearLogs={handleClearLogs}
          />
        </div>

        {isAdmin && (
          <div className={activeTab === 'admin' ? 'block' : 'hidden'}>
            <AdminPanel
              questions={questions}
              logs={logs}
              validators={validators}
              invites={invites}
              onRefreshInvites={refreshInvites}
              onRefreshValidators={refreshValidators}
              settings={settings}
              onSettingsSaved={setSettings}
              onResolveConsensus={handleResolveConsensus}
              onOpenValidatorProgress={() => setShowValidatorProgressModal(true)}
            />
          </div>
        )}

        {activeTab === 'curator' && (
          <>
            {/* Dynamic metrics card deck */}
            <StatsGrid
              stats={stats}
              activeStatusFilter={filters.status}
              onSelectStatusFilter={(status) => setFilters(prev => ({ ...prev, status }))}
            />

            {/* Distribution Charts */}
            <StatsCharts stats={stats} />

            {/* Filters control deck */}
            <FiltersPanel
              filters={filters}
              onChangeFilters={(updates) => setFilters(prev => ({ ...prev, ...updates }))}
              categories={uniqueCategories}
              sections={uniqueSections}
              onResetAll={handleResetFilters}
              hasActiveFilters={hasActiveFilters}
              validators={validators}
            />
            {/* Undo Last Bulk Action — restores exactly the questions the last
                bulk approve/reject touched, to exactly their prior state. */}
            {lastBulkSnapshot && !isAuditor && (
              <div className="mb-6 bg-amber-50 border border-amber-300/60 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 select-none">
                <div className="flex items-center gap-2 text-xs text-amber-800">
                  <History className="w-4 h-4 shrink-0" />
                  <span>
                    Last bulk action: <span className="font-bold">{lastBulkSnapshot.action_type.replace('_', ' ')}</span> by{' '}
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

            {/* Manual Selection Toolbar (appears once reviewer selects any question) — auditors are read-only */}
            {selectedIds.size > 0 && !isAuditor && (
              <div className="mb-6 bg-[#fafafa] border border-[#6366f1]/40 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 select-none">
                <span className="text-xs font-bold text-zinc-600">
                  {selectedIds.size} question(s) selected
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleApproveSelected}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-600 hover:bg-emerald-900 hover:text-white transition-all cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" /> Approve Selected
                  </button>
                  <button
                    onClick={handleRejectSelected}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-900 hover:text-white transition-all cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" /> Reject Selected
                  </button>
                  <button
                    onClick={handleClearSelection}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#e4e4e7] text-zinc-500 hover:text-zinc-900 hover:bg-[#f2f2f3] transition-all cursor-pointer"
                  >
                    Clear Selection
                  </button>
                </div>
              </div>
            )}
            {/* Overall Review Progress Bar */}
            {stats.total > 0 && (
              <div className="mb-6 bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-4 select-none">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-bold text-zinc-600 uppercase tracking-wide">
                    Overall Review Progress
                  </span>
                  <span className="font-mono text-xs font-bold text-zinc-500">
                    {reviewedCount} of {stats.total} reviewed ({reviewProgressPct}%)
                  </span>
                </div>
                <div className="w-full h-2.5 bg-[#f2f2f3] rounded-full overflow-hidden border border-[#e4e4e7]">
                  <div
                    className="h-full bg-[#6366f1] transition-all duration-500 ease-out"
                    style={{ width: `${reviewProgressPct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Question curation deck list heading */}
            <div className="flex justify-between items-center mb-4.5 select-none">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold tracking-tight text-zinc-600 uppercase">
                  Curated Test Bank Items
                </h3>
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
                      title="Tick the checkbox on every question currently visible"
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${filteredQuestions.length === 0
                          ? 'text-zinc-600 border-[#e4e4e7] bg-[#fafafa] cursor-not-allowed'
                          : 'text-zinc-600 border-[#e4e4e7] hover:text-zinc-900 hover:bg-[#f2f2f3]'
                        }`}
                    >
                      Select All Visible
                    </button>

                    <button
                      onClick={handleApproveAllFiltered}
                      disabled={filteredQuestions.length === 0}
                      title="Approve every question currently matching your filters"
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${filteredQuestions.length === 0
                          ? 'text-zinc-600 border-[#e4e4e7] bg-[#fafafa] cursor-not-allowed'
                          : 'text-emerald-600 border-emerald-200 bg-emerald-50 hover:bg-emerald-900 hover:text-white'
                        }`}
                    >
                      <Check className="w-3.5 h-3.5" /> Approve All Filtered ({filteredQuestions.length})
                    </button>

                    <button
                      onClick={handleRejectAllFiltered}
                      disabled={filteredQuestions.length === 0}
                      title="Reject every question currently matching your filters"
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${filteredQuestions.length === 0
                          ? 'text-zinc-600 border-[#e4e4e7] bg-[#fafafa] cursor-not-allowed'
                          : 'text-rose-600 border-rose-200 bg-rose-50 hover:bg-rose-900 hover:text-white'
                        }`}
                    >
                      <X className="w-3.5 h-3.5" /> Reject All Filtered ({filteredQuestions.length})
                    </button>
                  </>
                )}

                {isAdmin && (
                  <button
                    onClick={copyCurationToClipboard}
                    disabled={stats.approved === 0}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${stats.approved === 0
                        ? 'text-zinc-600 border-[#e4e4e7] bg-[#fafafa] cursor-not-allowed'
                        : 'text-zinc-600 border-[#e4e4e7] hover:text-zinc-900 hover:bg-[#f2f2f3]'
                      }`}
                  >
                    <ClipboardCopy className="w-3.5 h-3.5" /> Copy Approved JSON
                  </button>
                )}
              </div>
            </div>

            {/* Curation stream panel list */}
            <div className="space-y-4">
              <AnimatePresence mode="popLayout">
                {questions.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-12 text-center flex flex-col items-center justify-center shadow-xs"
                  >
                    <div className="w-12 h-12 rounded-full bg-[#f2f2f3] border border-[#e4e4e7] flex items-center justify-center text-[#4f46e5] mb-3.5">
                      <Upload className="w-5 h-5 animate-pulse" />
                    </div>
                    <h4 className="text-sm font-bold text-zinc-900">No questions loaded in your workspace yet</h4>
                    <p className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto leading-relaxed">
                      Drag and drop one or more SAT test bank JSON files onto the panel above, or use the{' '}
                      <span className="text-zinc-600 font-semibold">Upload / Merge JSON Bank(s)</span> button in the
                      top-right — multiple files/batches will be merged into one session.
                    </p>
                  </motion.div>
                ) : paginatedQuestions.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-12 text-center flex flex-col items-center justify-center shadow-xs"
                  >
                    <div className="w-12 h-12 rounded-full bg-[#f2f2f3] border border-[#e4e4e7] flex items-center justify-center text-zinc-500 mb-3.5">
                      <Info className="w-5 h-5" />
                    </div>
                    <h4 className="text-sm font-bold text-zinc-900">No questions match your filter query</h4>
                    <p className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto leading-relaxed">
                      Try adjusting the difficulty level, clearing your search input, or selecting another section status metric.
                    </p>
                    <button
                      onClick={handleResetFilters}
                      className="mt-4 px-4 py-2 bg-[#6366f1] text-white text-xs font-bold rounded-lg hover:bg-indigo-700 transition-all cursor-pointer border border-[#6366f1]"
                    >
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
                        if (next) {
                          document.getElementById(`question-${next.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
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
                      onOpenHistory={handleOpenHistory}
                    />
                  ))
                )}
              </AnimatePresence>
            </div>

            {/* Pagination controls (spec §3, §11) */}
            {filteredQuestions.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 mt-4 px-1">
                <div className="flex items-center gap-2 text-[12px] text-zinc-500">
                  <span>Sort by</span>
                  <select
                    value={sortField}
                    onChange={(e) => setSortField(e.target.value as SortField)}
                    className="bg-[#fafafa] border border-[#e4e4e7] rounded-md px-2 py-1 text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] cursor-pointer"
                  >
                    <option value="dateGenerated">Date generated</option>
                    <option value="difficulty">Difficulty</option>
                    <option value="category">Category</option>
                    <option value="id">Question ID</option>
                  </select>
                  <button
                    onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
                    title={sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
                    className="px-2 py-1 rounded-md border border-[#e4e4e7] text-zinc-600 hover:bg-[#f2f2f3] cursor-pointer font-bold"
                  >
                    {sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
                  </button>
                  <span className="text-zinc-500">|</span>
                  <span>Rows per page</span>
                  <select
                    value={pageSize}
                    onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                    className="bg-[#fafafa] border border-[#e4e4e7] rounded-md px-2 py-1 text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] cursor-pointer"
                  >
                    {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={pageSafe <= 1}
                    className="px-2.5 py-1.5 text-[12px] font-bold rounded-md border border-[#e4e4e7] text-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#f2f2f3] cursor-pointer"
                  >
                    Prev
                  </button>
                  <span className="text-[12px] text-zinc-500 font-mono px-1">
                    Page {pageSafe} of {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={pageSafe >= totalPages}
                    className="px-2.5 py-1.5 text-[12px] font-bold rounded-md border border-[#e4e4e7] text-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#f2f2f3] cursor-pointer"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}

      </main>

      {/* Inline item editor overlay */}
      <EditModal
        isOpen={isEditModalOpen}
        question={selectedEditQuestion}
        onClose={() => {
          setIsEditModalOpen(false);
          setSelectedEditQuestion(null);
        }}
        onSave={handleSaveEditedQuestion}
      />

      {/* Point 6: side-by-side near-duplicate comparison overlay */}
      <DuplicateCompareModal
        isOpen={!!duplicateCompareQuestion}
        flaggedQuestion={duplicateCompareQuestion}
        matchedQuestion={
          duplicateCompareQuestion?.similar_question_id
            ? questions.find(q => q.id === duplicateCompareQuestion.similar_question_id)
            : null
        }
        onClose={() => setDuplicateCompareQuestion(null)}
      />

      {/* Admin-only per-question revert history */}
      <QuestionHistoryDrawer
        isOpen={!!historyDrawerQuestion}
        question={historyDrawerQuestion}
        isAdmin={isAdmin}
        onClose={handleCloseHistory}
        onRestore={handleRestoreQuestionSnapshot}
      />

      {/* Daily validator progress export overlay (admin-only) */}
      <ValidatorProgressModal
        isOpen={showValidatorProgressModal}
        onClose={() => setShowValidatorProgressModal(false)}
        validators={validators}
        questions={questions}
        logs={logs}
        showToast={showToast}
      />

      {/* Bulk Action Confirmation Modal — required before any bulk approve/reject */}
      <AnimatePresence>
        {bulkConfirm && (() => {
          const isApprove = bulkConfirm.status === 'approved';
          // Always require typing CONFIRM before a bulk approve/reject goes
          // through, regardless of batch size — a single accidental click on
          // "Approve All Filtered" is exactly the kind of mistake this
          // guards against, not just large batches.
          const typedConfirmOk = bulkConfirmTypedText.trim().toUpperCase() === 'CONFIRM';
          const actionNoun = isApprove ? 'Approve' : 'Reject';
          const scopeLabel =
            bulkConfirm.actionType === 'approve_filtered' || bulkConfirm.actionType === 'reject_filtered'
              ? 'currently filtered'
              : 'manually selected';
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => !isSubmittingBulk && setBulkConfirm(null)}
                className="absolute inset-0 bg-black/90"
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                className="relative w-full max-w-md bg-[#fafafa] border border-[#e4e4e7] rounded-2xl p-6 shadow-2xl overflow-hidden z-10"
              >
                <div className="flex items-start gap-4">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 border ${isApprove ? 'bg-emerald-50 border-emerald-500/30 text-emerald-600' : 'bg-rose-50 border-rose-500/30 text-rose-500'}`}>
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div className="space-y-1.5 flex-1">
                    <h3 className="text-sm font-bold text-zinc-900 tracking-tight">
                      {actionNoun} {bulkConfirm.ids.length} {scopeLabel} question(s)?
                    </h3>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      This changes review status for {bulkConfirm.ids.length} question(s) at once. A snapshot of their
                      current state is saved first, so this can be undone afterward with "Undo Last Bulk Action" —
                      but double-check your filters/selection before continuing.
                    </p>
                  </div>
                </div>

                <div className="mt-4">
                  <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wide">
                    Type CONFIRM to proceed
                  </label>
                  <input
                    autoFocus
                    value={bulkConfirmTypedText}
                    onChange={(e) => setBulkConfirmTypedText(e.target.value)}
                    placeholder="CONFIRM"
                    className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-[#e4e4e7] bg-white focus:outline-none focus:ring-2 focus:ring-[#6366f1]/40"
                  />
                </div>

                <div className="mt-6 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    disabled={isSubmittingBulk}
                    onClick={() => setBulkConfirm(null)}
                    className="px-4 py-2 text-xs font-bold text-zinc-500 hover:text-zinc-900 bg-[#f2f2f3] hover:bg-[#e8e8e9] border border-[#e4e4e7] rounded-xl transition-all cursor-pointer disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!typedConfirmOk || isSubmittingBulk}
                    onClick={executeBulkConfirm}
                    className={`px-4 py-2 text-xs font-bold text-white rounded-xl transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${isApprove ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}
                  >
                    {isSubmittingBulk ? 'Working…' : `${actionNoun} ${bulkConfirm.ids.length}`}
                  </button>
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      {/* Custom Confirmation Modal for Clearing Workspace */}
      <AnimatePresence>
        {isClearConfirmOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsClearConfirmOpen(false)}
              className="absolute inset-0 bg-black/90"
            />

            {/* Modal Content */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="relative w-full max-w-md bg-[#fafafa] border border-[#e4e4e7] rounded-2xl p-6 shadow-2xl overflow-hidden z-10"
            >
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-rose-50 border border-rose-500/30 flex items-center justify-center text-rose-500 shrink-0">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div className="space-y-1.5 flex-1">
                  <h3 className="text-sm font-bold text-zinc-900 tracking-tight">Wipe Curation Workspace?</h3>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    This action will clear all current {questions.length} questions from your session workspace permanently. Any unsaved curation status or edits will be lost.
                  </p>
                </div>
              </div>

              <div className="mt-4">
                <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wide">
                  Type WIPE to proceed
                </label>
                <input
                  autoFocus
                  value={clearConfirmTypedText}
                  onChange={(e) => setClearConfirmTypedText(e.target.value)}
                  placeholder="WIPE"
                  className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-[#e4e4e7] bg-white focus:outline-none focus:ring-2 focus:ring-rose-500/40"
                />
              </div>

              <div className="mt-6 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsClearConfirmOpen(false)}
                  className="px-4 py-2 text-xs font-bold text-zinc-500 hover:text-zinc-900 bg-[#f2f2f3] hover:bg-[#e8e8e9] border border-[#e4e4e7] rounded-xl transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={clearConfirmTypedText.trim().toUpperCase() !== 'WIPE'}
                  onClick={async () => {
                    setIsClearConfirmOpen(false);
                    const ok = await deleteAllQuestions();
                    if (ok) {
                      showToast('Workspace cleared. Upload a JSON file to get started!', 'info');
                      logEvent('clear', 'Wiped all questions from the active curation workspace');
                      if (fileInputRef.current) {
                        fileInputRef.current.value = '';
                      }
                    }
                    // On failure, deleteAllQuestions already showed an error toast and
                    // left both local state and Supabase untouched.
                  }}
                  className="px-4 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 border border-rose-600 rounded-xl transition-all cursor-pointer shadow-sm shadow-rose-950/50 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-rose-600"
                >
                  Yes, Wipe Workspace
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Custom float toast system notifications overlay */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 35, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="fixed bottom-6 right-6 z-50 p-4 rounded-xl border shadow-2xl flex items-center gap-3 max-w-md bg-[#fafafa] text-zinc-900 border-[#e4e4e7]"
          >
            <div className="w-6 h-6 rounded-full bg-[#f2f2f3] flex items-center justify-center shrink-0 border border-[#e4e4e7]">
              <Check className="w-3.5 h-3.5 text-emerald-600 stroke-3" />
            </div>
            <p className="text-xs font-medium leading-normal text-zinc-700">{toast.message}</p>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}