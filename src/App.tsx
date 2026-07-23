import React, { useState, useEffect, useRef } from 'react';
import { SATQuestion, FilterState, StatsSummary, QuestionComment, SortField, SortDirection, ValidatorInvite, MAX_CONSENSUS_REVIEWERS } from './types';
import StatsGrid from './components/StatsGrid';
import FiltersPanel from './components/FiltersPanel';
import StatsCharts from './components/StatsCharts';
import QuestionCard from './components/QuestionCard';
import EditModal from './components/EditModal';
import DomainAnalytics from './components/DomainAnalytics';
import AuditActivityLogs, { AuditLogEntry } from './components/AuditActivityLogs';
import DuplicateCompareModal from './components/DuplicateCompareModal';
import AdminPanel from './components/AdminPanel';
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
  RotateCcw,
  FileText,
  ClipboardCopy,
  Check,
  Info,
  X,
  Layers,
  History,
  PieChart,
  Grid,
  User,
  LogOut,
  ShieldCheck,
  Clock,
  FileSpreadsheet,
  XCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';

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
    supabase
      .from('profiles')
      .select('id, email, name, role, active')
      .eq('id', session.user.id)
      .single()
      .then(({ data, error }) => {
        if (!error && data) {
          if (!(data as Profile).active) {
            setPendingApproval(true);
            return;
          }
          setPendingApproval(false);
          setProfile(data as Profile);
        }
      });
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
  const [activeTab, setActiveTab] = useState<'curator' | 'analytics' | 'audit' | 'admin'>('curator');

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
  const [selectedEditQuestion, setSelectedEditQuestion] = useState<SATQuestion | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // --- Point 6: side-by-side duplicate compare modal state ---
  const [duplicateCompareQuestion, setDuplicateCompareQuestion] = useState<SATQuestion | null>(null);

  // --- Activity Logs state (now backed by Supabase, shared across validators) ---
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);

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

      const { data: logRows, error: lError } = await supabase
        .from('audit_log')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(1000);
      if (!cancelled && !lError && logRows) {
        setLogs(logRows.map((r: any) => ({
          id: r.id,
          timestamp: new Date(r.timestamp).toLocaleString(),
          rawTimestamp: r.timestamp,
          action: r.action,
          questionId: r.question_id || undefined,
          description: r.description,
          user: r.user_name || undefined
        })));
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
          return exists ? prev.map(q => q.id === incoming.id ? incoming : q) : [...prev, incoming];
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
          user: r.user_name || undefined
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
  const saveQuestions = (updated: SATQuestion[]) => {
    const prevMap = new Map(questions.map(q => [q.id, q]));
    setQuestions(updated);

    const changed = updated.filter(q => {
      const prev = prevMap.get(q.id);
      return !prev || JSON.stringify(prev) !== JSON.stringify(q);
    });

    const newRows = changed.filter(q => !prevMap.has(q.id));
    const existingRows = changed.filter(q => prevMap.has(q.id));

    const bumpPending = (id: string, delta: number) => {
      const map = pendingWritesRef.current;
      const next = (map.get(id) || 0) + delta;
      if (next > 0) map.set(id, next); else map.delete(id);
    };

    changed.forEach(q => bumpPending(q.id, 1));
    const releasePending = (rows: SATQuestion[]) => rows.forEach(q => bumpPending(q.id, -1));

    const ops = [];
    if (newRows.length > 0) {
      ops.push(
        supabase.from('questions').insert(newRows.map(questionToRow))
          .then(result => { releasePending(newRows); return result; })
      );
    }
    existingRows.forEach(q => {
      ops.push(
        supabase.from('questions').update(questionToRow(q)).eq('id', q.id)
          .then(result => { releasePending([q]); return result; })
      );
    });

    if (ops.length > 0) {
      Promise.all(ops).then(results => {
        const failed = results.find(r => r.error);
        if (failed && failed.error) showToast(`Failed to save to Supabase: ${failed.error.message}`, 'error');
      });
    }
  };

  // --- Bug fix: "Wipe Workspace" used to call saveQuestions([]), which never
  // issues a delete (see note above), so wiped rows silently reappeared on
  // reload. This explicitly deletes every row currently loaded, then clears
  // local state only once the delete has actually succeeded. ---
  const deleteAllQuestions = async () => {
    const idsToDelete = questions.map(q => q.id).filter(Boolean);
    if (idsToDelete.length === 0) {
      setQuestions([]);
      return true;
    }
    // Delete every row unconditionally rather than matching a per-id IN-list —
    // a large or special-character-containing id list can break the IN-list
    // query syntax and return a 400 Bad Request even for a real admin.
    const { error } = await supabase.from('questions').delete().neq('id', '');
    if (error) {
      showToast(`Failed to wipe workspace: ${error.message}`, 'error');
      return false;
    }
    setQuestions([]);
    return true;
  };

  // --- Session logging helper: append-only insert into Supabase audit_log.
  // The local `logs` state updates via the realtime subscription above, so we
  // don't also splice it in here (avoids duplicate entries). ---
  const logEvent = (action: 'approve' | 'reject' | 'reset' | 'edit' | 'upload' | 'clear' | 'note', description: string, questionId?: string) => {
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
    const updated = questions.map(q => q.id === id ? { ...q, reviewStatus: 'approved' as const } : q);
    saveQuestions(updated);
    showToast('Question item approved for test bank.', 'success');
    logEvent('approve', `Approved item "${id}" for the test bank in "${question?.category || 'General'}"`, id);
  };

  const handleReject = (id: string) => {
    if (blockIfAuditor()) return;
    const question = questions.find(q => q.id === id);
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
      logEvent(
        value ? 'approve' : 'reject',
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
    const { data, error } = await supabase
      .from('questions')
      .update({ claimed_by: session?.user.id || null, claimed_by_name: validatorName, claimed_at: claimedAt })
      .eq('id', id)
      .is('claimed_by', null) // <-- the atomic guard: only claims if still unclaimed server-side
      .select('id');

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
    setIsClearConfirmOpen(true);
  };

  // --- Bulk Action Handlers (act on currently filtered questions only) ---
  const handleApproveAllFiltered = () => {
    if (blockIfAuditor()) return;
    const idsToApprove = filteredQuestions.map(q => q.id);
    if (idsToApprove.length === 0) {
      showToast('No filtered questions to approve.', 'error');
      return;
    }
    const updated = questions.map(q =>
      idsToApprove.includes(q.id) ? { ...q, reviewStatus: 'approved' as const } : q
    );
    saveQuestions(updated);
    showToast(`Approved ${idsToApprove.length} filtered question(s).`, 'success');
    logEvent('approve', `Bulk approved ${idsToApprove.length} filtered item(s)`);
  };

  const handleRejectAllFiltered = () => {
    if (blockIfAuditor()) return;
    const idsToReject = filteredQuestions.map(q => q.id);
    if (idsToReject.length === 0) {
      showToast('No filtered questions to reject.', 'error');
      return;
    }
    const updated = questions.map(q =>
      idsToReject.includes(q.id) ? { ...q, reviewStatus: 'rejected' as const } : q
    );
    saveQuestions(updated);
    showToast(`Rejected ${idsToReject.length} filtered question(s).`, 'info');
    logEvent('reject', `Bulk rejected ${idsToReject.length} filtered item(s)`);
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
    const updated = questions.map(q =>
      selectedIds.has(q.id) ? { ...q, reviewStatus: 'approved' as const } : q
    );
    saveQuestions(updated);
    showToast(`Approved ${selectedIds.size} selected question(s).`, 'success');
    logEvent('approve', `Bulk approved ${selectedIds.size} manually selected item(s)`);
    setSelectedIds(new Set());
  };

  const handleRejectSelected = () => {
    if (blockIfAuditor()) return;
    if (selectedIds.size === 0) {
      showToast('No questions selected.', 'error');
      return;
    }
    const updated = questions.map(q =>
      selectedIds.has(q.id) ? { ...q, reviewStatus: 'rejected' as const } : q
    );
    saveQuestions(updated);
    showToast(`Rejected ${selectedIds.size} selected question(s).`, 'info');
    logEvent('reject', `Bulk rejected ${selectedIds.size} manually selected item(s)`);
    setSelectedIds(new Set());
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

  const sanitizeQuestion = (q: any, idx: number): SATQuestion => ({
    id: q.id || `curated-sat-${Date.now()}-${idx + 1}`,
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
    requiresSecondReview: q.requiresSecondReview ?? isInConsensusSample(q.id || `curated-sat-${Date.now()}-${idx + 1}`, settings.consensus_sample_rate || 0.1),
    consensusReviews: Array.isArray(q.consensusReviews) ? q.consensusReviews : []
  });

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

  // --- Curation Exports (spec: exports are an admin-only action) ---
  const downloadCuration = (onlyApproved: boolean) => {
    if (!isAdmin) {
      showToast('Only admins can export questions.', 'error');
      return;
    }
    if (questions.length === 0) {
      showToast('No questions available to export.', 'error');
      return;
    }

    const filtered = onlyApproved
      ? questions.filter(q => q.reviewStatus === 'approved')
      : questions;

    if (onlyApproved && filtered.length === 0) {
      showToast('You must approve at least one question before downloading the official test bank!', 'error');
      return;
    }

    // Strip transient UI-only properties (like reviewStatus) to match the exact original format
    const cleanFiltered = filtered.map(({ reviewStatus, ...rest }) => rest);

    // Create a Blob to download safely and robustly within restricted sandbox environments (iframes)
    const blob = new Blob([JSON.stringify(cleanFiltered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', url);

    const filename = onlyApproved
      ? `curated-sat-test-bank-${Date.now()}.json`
      : `sat-audit-log-${Date.now()}.json`;

    downloadAnchor.setAttribute('download', filename);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();

    // Cleanup reference after small delay
    setTimeout(() => {
      document.body.removeChild(downloadAnchor);
      URL.revokeObjectURL(url);
    }, 100);

    showToast(`Successfully exported ${filtered.length} questions in original JSON format!`, 'success');
  };

  // --- Distinct "production question bank" export (spec §10, §12, §13) ---
  // Unlike downloadCuration (which round-trips the app's own internal JSON
  // shape), this maps approved questions to the spec's production data model
  // — the format MySAT AI Coach's production bank is meant to consume.
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

  // --- Excel (.xlsx) export ---
  // Exports approved questions as a flat, spreadsheet-friendly workbook —
  // one row per question, choices split into their own columns, consensus
  // review info summarized — so it can be opened directly in Excel/Sheets
  // for offline review or handoff to non-technical stakeholders.
  const downloadExcel = () => {
    if (!isAdmin) {
      showToast('Only admins can export questions.', 'error');
      return;
    }
    const approved = questions.filter(q => q.reviewStatus === 'approved');
    if (approved.length === 0) {
      showToast('No approved questions yet — approve some before exporting to Excel.', 'error');
      return;
    }

    const rows = approved.map(q => ({
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
      'Consensus Reviews': (q.consensusReviews || []).length,
      'Generator Run ID': q.generatorRunId || '',
      'Created At': q.createdAt || ''
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);

    // Reasonable default column widths so text isn't clipped on first open
    worksheet['!cols'] = [
      { wch: 14 }, // ID
      { wch: 10 }, // Section
      { wch: 18 }, // Category
      { wch: 18 }, // Sub Skill
      { wch: 12 }, // Question Type
      { wch: 10 }, // Difficulty
      { wch: 40 }, // Passage
      { wch: 40 }, // Question
      { wch: 25 }, // Choice A
      { wch: 25 }, // Choice B
      { wch: 25 }, // Choice C
      { wch: 25 }, // Choice D
      { wch: 14 }, // Correct Answer
      { wch: 40 }, // Explanation
      { wch: 14 }, // Review Status
      { wch: 16 }, // Consensus Reviews
      { wch: 18 }, // Generator Run ID
      { wch: 20 }, // Created At
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Approved Questions');
    XLSX.writeFile(workbook, `curated-sat-test-bank-${Date.now()}.xlsx`);

    showToast(`Exported ${rows.length} question(s) to Excel!`, 'success');
    logEvent('note', `Exported ${rows.length} question(s) to Excel (.xlsx)`);
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
    navigator.clipboard.writeText(JSON.stringify(cleanApproved, null, 2));
    showToast('Copied approved questions payload directly to your clipboard in original JSON format!', 'success');
  };

  // --- Rejected questions export, including the full review trail (admin-only) ---
  // Unlike the other exports (which only ever include approved items), this
  // pulls every rejected question and bundles in *why* it was rejected: the
  // 4-check validation checklist, any manual status-override justification,
  // the threaded reviewer comments/notes, and — if it went through second
  // opinion / consensus — each consensus reviewer's independent checks.
  const downloadRejectedWithReview = () => {
    if (!isAdmin) {
      showToast('Only admins can export questions.', 'error');
      return;
    }

    const rejected = questions.filter(q => q.reviewStatus === 'rejected');
    if (rejected.length === 0) {
      showToast('No rejected questions to export.', 'error');
      return;
    }

    const rejectedRecords = rejected.map(q => ({
      id: q.id,
      category: q.category,
      subSkill: q.subSkill || null,
      questionType: q.questionType || 'mcq',
      Section: q.Section || q.section || null,
      difficulty: q.difficulty,
      passage: q.passage,
      stimulus: q.stimulus || null,
      question: q.question,
      choices: q.choices,
      correct_answer: q.correct_answer,
      explanation: q.explanation,
      generatorRunId: q.generatorRunId || null,
      createdAt: q.createdAt || null,
      review: {
        reviewStatus: q.reviewStatus,
        reviewedBy: q.claimedByName || q.assignedToName || null,
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
        pipelineValidatorStatus: q.validatorStatus || null,
        pipelineValidatorFeedback: q.validatorFeedback || null
      }
    }));

    const blob = new Blob([JSON.stringify(rejectedRecords, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', url);
    downloadAnchor.setAttribute('download', `rejected-questions-with-review-${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    setTimeout(() => {
      document.body.removeChild(downloadAnchor);
      URL.revokeObjectURL(url);
    }, 100);

    showToast(`Exported ${rejectedRecords.length} rejected question(s) with full review details.`, 'success');
    logEvent('note', `Exported ${rejectedRecords.length} rejected question(s) with review details`);
  };

  // --- Dynamic Stats Engine ---
  const stats: StatsSummary = {
    total: questions.length,
    pending: questions.filter(q => !q.reviewStatus || q.reviewStatus === 'pending').length,
    approved: questions.filter(q => q.reviewStatus === 'approved').length,
    rejected: questions.filter(q => q.reviewStatus === 'rejected').length,
    needsRevision: questions.filter(q => q.reviewStatus === 'needs_revision').length,
    bySection: {},
    byDifficulty: { easy: 0, medium: 0, hard: 0 },
    byCategory: {}
  };

  questions.forEach(q => {
    // Normalize section string
    const s = q.Section || q.section || 'Reading_Writing';
    stats.bySection[s] = (stats.bySection[s] || 0) + 1;

    // Normalize difficulty
    const d = (q.difficulty || 'medium').toLowerCase();
    stats.byDifficulty[d] = (stats.byDifficulty[d] || 0) + 1;

    // Normalize category
    const c = q.category || 'General';
    stats.byCategory[c] = (stats.byCategory[c] || 0) + 1;
  });

  // Extract list of all unique categories and sections present for dropdown filters
  const uniqueCategories = Array.from(new Set<string>(questions.map(q => q.category as string))).sort();
  const uniqueSections = Array.from(new Set<string>(questions.map(q => (q.Section || q.section || 'Reading_Writing') as string))).sort();

  // --- Filter Evaluation Engine ---
  const filteredQuestions = questions.filter(q => {
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
    const difficultyMatch = !filters.difficulty || q.difficulty.toLowerCase() === filters.difficulty.toLowerCase();

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
  });

  // --- Sort control (spec §3: "Filter/sort by ... date generated ...") ---
  const difficultyRank: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
  const sortedQuestions = [...filteredQuestions].sort((a, b) => {
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
  });

  // --- Pagination (spec §3, §11: queue supports 10k+ questions without degradation) ---
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  useEffect(() => {
    setCurrentPage(1);
  }, [filters, questions.length]);
  const totalPages = Math.max(1, Math.ceil(filteredQuestions.length / pageSize));
  const pageSafe = Math.min(currentPage, totalPages);
  const paginatedQuestions = sortedQuestions.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);

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
              <span className="text-xs text-zinc-700 max-w-[120px] truncate">{validatorName}</span>
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

            <span className="h-4 w-px bg-[#e4e4e7] mx-1" />

            {/* Start Fresh options — not available to read-only auditors */}
            {!isAuditor && (
              <>
                <button
                  onClick={handleClearAllQuestions}
                  title="Clear current workspace items"
                  className="p-2 text-zinc-500 hover:text-rose-600 border border-[#e4e4e7] hover:bg-rose-50 rounded-lg transition-all cursor-pointer bg-[#fafafa]"
                >
                  <Trash2 className="w-4 h-4" />
                </button>

                <span className="h-4 w-px bg-[#e4e4e7] mx-1" />
              </>
            )}

            {/* Exports are an admin-only action — validators/auditors never see these */}
            {isAdmin && (
              <>
                <button
                  onClick={() => downloadCuration(true)}
                  disabled={stats.approved === 0}
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer ${stats.approved === 0
                      ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed'
                      : 'bg-[#6366f1] hover:bg-indigo-700 text-white border-[#6366f1] shadow-xs'
                    }`}
                >
                  <Download className="w-3.5 h-3.5" />
                  Export Test Bank
                </button>

                {/* Distinct production question bank export (spec §10, §12, §13) */}
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

                {/* Excel (.xlsx) export of approved questions */}
                <button
                  onClick={downloadExcel}
                  disabled={stats.approved === 0}
                  title="Export approved questions as an Excel spreadsheet"
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer ${stats.approved === 0
                      ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed'
                      : 'bg-green-700 hover:bg-green-600 text-white border-green-700 shadow-xs'
                    }`}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  Export Excel
                </button>

                {/* Rejected questions export — bundles in the full review trail (spec extension) */}
                <button
                  onClick={downloadRejectedWithReview}
                  disabled={stats.rejected === 0}
                  title="Export rejected questions as JSON, including the review checklist, comments, and rejection justification"
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer ${stats.rejected === 0
                      ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed'
                      : 'bg-rose-800 hover:bg-rose-700 text-white border-rose-800 shadow-xs'
                    }`}
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Export Rejected
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Body Grid */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">

        {/* Banner callout */}
        <div className="mb-6 bg-gradient-to-r from-[#fafafa] to-[#f2f2f3] text-zinc-900 rounded-2xl p-6 relative overflow-hidden flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border border-[#e4e4e7] shadow-sm">
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
        {activeTab === 'analytics' && (
          <DomainAnalytics
            questions={questions}
            onSelectSubdomainFilter={handleSelectSubdomainFilter}
          />
        )}

        {activeTab === 'audit' && (
          <AuditActivityLogs
            logs={logs}
            onClearLogs={handleClearLogs}
          />
        )}

        {activeTab === 'admin' && isAdmin && (
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
          />
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
                      auditLogs={logs.filter(l => l.questionId === question.id)}
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
              className="absolute inset-0 bg-[#000]/90"
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
                  className="px-4 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 border border-rose-600 rounded-xl transition-all cursor-pointer shadow-sm shadow-rose-950/50"
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
              <Check className="w-3.5 h-3.5 text-emerald-600 stroke-[3]" />
            </div>
            <p className="text-xs font-medium leading-normal text-zinc-700">{toast.message}</p>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}