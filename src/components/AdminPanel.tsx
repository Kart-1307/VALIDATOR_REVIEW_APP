import { useState, useMemo, useEffect } from 'react';
import { Users, Activity, Clock, Scale, Save, Webhook, UserPlus, Trash, Calendar, Percent, AlertCircle, AlertTriangle, FileSpreadsheet, CalendarClock, ListPlus, MessageSquare, CheckCircle2, XCircle, RotateCcw } from 'lucide-react';
import { SATQuestion, ValidatorInvite, MAX_CONSENSUS_REVIEWERS } from '../types';
import { AuditLogEntry } from './AuditActivityLogs';
import { supabase, Profile } from '../lib/supabaseClient';
import { getConsensusResolution } from '../lib/consensus';

interface AdminPanelProps {
  questions: SATQuestion[];
  logs: AuditLogEntry[];
  validators: Profile[];
  invites: ValidatorInvite[];
  onRefreshInvites: () => void;
  onRefreshValidators: () => void;
  settings: { rejection_webhook_url: string | null; consensus_sample_rate: number };
  onSettingsSaved: (s: { rejection_webhook_url: string | null; consensus_sample_rate: number }) => void;
  // Admin-only: resolve a primary-reviewer vs. second-opinion disagreement
  onResolveConsensus?: (id: string, resolution: 'primary' | 'second_opinion') => void;
  // Opens the daily validator progress export modal (owned/rendered by App.tsx)
  onOpenValidatorProgress?: () => void;
}

// yyyy-mm-dd in India Standard Time (Asia/Kolkata) — ensures all global validator activity is grouped under India workdays
const toLocalDateKey = (d: Date | string) => {
  const dateObj = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dateObj);
};
const todayKey = () => toLocalDateKey(new Date());

// Description-based classifiers for log entries whose `action` field alone
// doesn't distinguish them (e.g. "needs revision" and claims are logged
// under action: 'edit'). Matched against the exact phrasing logEvent() calls
// in App.tsx use — see ValidatorProgressModal.tsx for the same approach.
const isNeedsRevisionLog = (d: string) =>
  /overall status now needs revision/i.test(d) || /overrode overall status of item ".*?" to "needs_revision"/i.test(d);
const isClaimLog = (d: string) => /claimed item ".*?" for review/i.test(d);
const isCommentLog = (d: string) => /commented on item/i.test(d);

export default function AdminPanel({
  questions,
  logs,
  validators,
  invites,
  onRefreshInvites,
  onRefreshValidators,
  settings,
  onSettingsSaved,
  onResolveConsensus,
  onOpenValidatorProgress
}: AdminPanelProps) {
  const [webhookDraft, setWebhookDraft] = useState(settings.rejection_webhook_url || '');
  const [rateDraft, setRateDraft] = useState(Math.round((settings.consensus_sample_rate || 0.1) * 100));
  const [savingSettings, setSavingSettings] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Fetch New Batch Workspace (questions_batch2) metadata for complete dataset parity
  const [batch2Questions, setBatch2Questions] = useState<any[]>([]);
  useEffect(() => {
    let cancelled = false;
    supabase
      .from('questions_batch2')
      .select('id, review_status, claimed_by_name, assigned_to_name, created_at, updated_at, comments')
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        setBatch2Questions(data);
      });
    return () => { cancelled = true; };
  }, [logs]);

  // --- §2: role / active management ---
  const updateValidator = async (id: string, patch: Partial<Pick<Profile, 'role' | 'active'>>) => {
    const { error } = await supabase.from('profiles').update(patch).eq('id', id);
    if (!error) {
      onRefreshValidators();
    }
  };

  // --- Invite Validator state (spec §2) ---
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'validator' | 'admin' | 'auditor'>('validator');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim() || !inviteName.trim()) return;
    setInviting(true);
    setInviteError(null);
    const email = inviteEmail.trim().toLowerCase();
    const name = inviteName.trim();
    try {
      // 1. Pre-authorize: write the whitelist row the `handle_new_user` DB
      // trigger checks against. Kept even though step 2 also triggers that
      // same row-consumption path, so pre-auth still works as a fallback if
      // the invite email fails to send but the person signs up manually.
      const { error: insertError } = await supabase.from('validator_invites').insert({
        email,
        name,
        role: inviteRole
      });
      if (insertError) throw insertError;

      // 2. Actually send the invite email via the send-validator-invite edge
      // function (admin.inviteUserByEmail under the hood). This also creates
      // their auth.users row immediately, which fires handle_new_user right
      // away — so their profile gets created/activated as soon as this call
      // succeeds, not only once they click the emailed link.
      const { data: sessionData } = await supabase.auth.getSession();
      const { data: fnData, error: fnError } = await supabase.functions.invoke('send-validator-invite', {
        body: { email, name, role: inviteRole },
        headers: sessionData.session ? { Authorization: `Bearer ${sessionData.session.access_token}` } : undefined
      });

      if (fnError || (fnData && (fnData as any).error)) {
        // The whitelist row is still in place, so this isn't a hard failure —
        // the person just won't get an automatic email. Surface it clearly.
        const msg = (fnData as any)?.error || fnError?.message || 'Invite saved, but the email failed to send.';
        setInviteError(`${msg} (The pre-authorization was still saved — you can tell them to sign up manually with this email.)`);
      } else {
        setInviteEmail('');
        setInviteName('');
        setInviteRole('validator');
      }
      // Refresh both: onRefreshInvites picks up the whitelist row being gone
      // (or still there, on email failure); onRefreshValidators picks up the
      // new profile row that the DB trigger creates the instant the invite
      // email succeeds — without this, it silently sits in the database
      // until something else happens to trigger a refetch (e.g. a reload).
      onRefreshInvites();
      onRefreshValidators();
    } catch (err: any) {
      setInviteError(err.message || 'Failed to send invite.');
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvite = async (email: string) => {
    if (!window.confirm(`Are you sure you want to cancel the invite for ${email}?`)) return;
    const { error } = await supabase.from('validator_invites').delete().eq('email', email);
    if (!error) {
      onRefreshInvites();
    }
  };

  // Lookup map to normalize user names across logs using profile ID, email, or name
  const userCanonicalNameMap = useMemo(() => {
    const map = new Map<string, string>();
    validators.forEach(v => {
      const canonical = v.name || v.email;
      if (v.id) map.set(v.id.toLowerCase(), canonical);
      if (v.email) map.set(v.email.toLowerCase(), canonical);
      if (v.name) map.set(v.name.toLowerCase(), canonical);
    });
    return map;
  }, [validators]);

  const getCanonicalUserName = (l: AuditLogEntry) => {
    if (l.userId && userCanonicalNameMap.has(l.userId.toLowerCase())) {
      return userCanonicalNameMap.get(l.userId.toLowerCase())!;
    }
    if (l.user && userCanonicalNameMap.has(l.user.toLowerCase())) {
      return userCanonicalNameMap.get(l.user.toLowerCase())!;
    }
    return l.user || 'Unknown Curator';
  };

  // --- Daily Snapshot date & full day logs state ---
  const [snapshotDate, setSnapshotDate] = useState<string>(todayKey());

  // Logs helper: uses logs prop directly (pre-fetched by App.tsx) as the single source of truth for 0ms instant rendering
  const effectiveLogs = logs;

  // Logs specifically for the selected snapshotDate in Daily Snapshot
  const fullDayLogs = useMemo(() => {
    return logs.filter(l => l.rawTimestamp && toLocalDateKey(l.rawTimestamp) === snapshotDate);
  }, [logs, snapshotDate]);

  // Helper: check if a log entry represents a completed evaluation decision (Approved, Rejected, or Needs Revision)
  const isDecisionLog = (l: AuditLogEntry) =>
    l.action === 'approve' ||
    l.action === 'reject' ||
    isNeedsRevisionLog(l.description);

  // --- §9: throughput per validator per day (deduplicated by unique completed decision questions touched in IST) ---
  const dailyThroughput = useMemo(() => {
    const dailyMap: Record<string, Record<string, { actions: number; questionIds: Set<string> }>> = {};
    effectiveLogs.forEach(l => {
      if (!l.rawTimestamp) return;
      const dateKey = toLocalDateKey(l.rawTimestamp);
      const userKey = getCanonicalUserName(l);
      if (!dailyMap[dateKey]) {
        dailyMap[dateKey] = {};
      }
      if (!dailyMap[dateKey][userKey]) {
        dailyMap[dateKey][userKey] = { actions: 0, questionIds: new Set() };
      }
      dailyMap[dateKey][userKey].actions += 1;
      // Strict rule: ONLY count questions that have a completed decision (Approved, Rejected, or Needs Revision)
      if (l.questionId && isDecisionLog(l)) {
        dailyMap[dateKey][userKey].questionIds.add(l.questionId);
      }
    });

    const entries: { date: string; displayDate: string; user: string; uniqueQuestions: number; actions: number }[] = [];
    Object.entries(dailyMap).forEach(([date, userMap]) => {
      const displayDate = date;
      Object.entries(userMap).forEach(([user, stats]) => {
        entries.push({
          date,
          displayDate,
          user,
          uniqueQuestions: stats.questionIds.size,
          actions: stats.actions
        });
      });
    });

    return entries.sort((a, b) => b.date.localeCompare(a.date));
  }, [effectiveLogs, userCanonicalNameMap]);

  // --- §9: throughput per validator (last 14 days summary: completed decision questions in IST) ---
  const throughputSummary = useMemo(() => {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const byValidatorQuestions: Record<string, Set<string>> = {};
    const actionsByValidator: Record<string, number> = {};
    effectiveLogs.forEach(l => {
      if (!l.rawTimestamp) return;
      if (new Date(l.rawTimestamp).getTime() < cutoff) return;
      const key = getCanonicalUserName(l);
      if (!byValidatorQuestions[key]) {
        byValidatorQuestions[key] = new Set();
        actionsByValidator[key] = 0;
      }
      actionsByValidator[key] += 1;
      // Strict rule: ONLY count questions that have a completed decision (Approved, Rejected, or Needs Revision)
      if (l.questionId && isDecisionLog(l)) {
        byValidatorQuestions[key].add(l.questionId);
      }
    });
    return Object.keys(actionsByValidator).map(user => {
      const count = byValidatorQuestions[user].size;
      return [user, count] as [string, number];
    }).sort((a, b) => b[1] - a[1]);
  }, [effectiveLogs, userCanonicalNameMap]);
  const maxThroughputSummary = Math.max(1, ...throughputSummary.map(([, n]) => n));

  // --- §9: pass/fail/revision rates by category and difficulty ---
  const statusRates = useMemo(() => {
    const byCategory: Record<string, { total: number; approved: number; rejected: number; needsRevision: number }> = {};
    const byDifficulty: Record<string, { total: number; approved: number; rejected: number; needsRevision: number }> = {
      easy: { total: 0, approved: 0, rejected: 0, needsRevision: 0 },
      medium: { total: 0, approved: 0, rejected: 0, needsRevision: 0 },
      hard: { total: 0, approved: 0, rejected: 0, needsRevision: 0 }
    };

    questions.forEach(q => {
      const cat = q.category || 'General';
      const diff = (q.difficulty || 'medium').toLowerCase();
      const status = q.reviewStatus || 'pending';

      // Category
      if (!byCategory[cat]) {
        byCategory[cat] = { total: 0, approved: 0, rejected: 0, needsRevision: 0 };
      }
      byCategory[cat].total++;
      if (status === 'approved') byCategory[cat].approved++;
      else if (status === 'rejected') byCategory[cat].rejected++;
      else if (status === 'needs_revision') byCategory[cat].needsRevision++;

      // Difficulty
      if (byDifficulty[diff] !== undefined) {
        byDifficulty[diff].total++;
        if (status === 'approved') byDifficulty[diff].approved++;
        else if (status === 'rejected') byDifficulty[diff].rejected++;
        else if (status === 'needs_revision') byDifficulty[diff].needsRevision++;
      }
    });

    const getRates = (stats: { total: number; approved: number; rejected: number; needsRevision: number }) => {
      if (stats.total === 0) return { pass: 0, fail: 0, revision: 0 };
      return {
        pass: Math.round((stats.approved / stats.total) * 100),
        fail: Math.round((stats.rejected / stats.total) * 100),
        revision: Math.round((stats.needsRevision / stats.total) * 100)
      };
    };

    return {
      categoryRates: Object.entries(byCategory).map(([name, stats]) => ({ name, stats, rates: getRates(stats) })),
      difficultyRates: Object.entries(byDifficulty).map(([name, stats]) => ({ name, stats, rates: getRates(stats) }))
    };
  }, [questions]);

  // --- §9: configurable backlog size and aging ---
  const [backlogAgeThreshold, setBacklogAgeThreshold] = useState<number>(3);
  const agingBacklog = useMemo(() => {
    const pending = questions.filter(q => !q.reviewStatus || q.reviewStatus === 'pending' || q.reviewStatus === 'needs_revision');
    const now = Date.now();
    const thresholdMs = backlogAgeThreshold * 24 * 60 * 60 * 1000;

    const agedList = pending.filter(q => {
      const ageMs = now - new Date(q.createdAt || now).getTime();
      return ageMs > thresholdMs;
    }).map(q => {
      const ageMs = now - new Date(q.createdAt || now).getTime();
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      return {
        id: q.id,
        category: q.category,
        difficulty: q.difficulty,
        assignedToName: q.assignedToName || q.claimedByName || 'Unassigned',
        ageDays
      };
    });

    agedList.sort((a, b) => b.ageDays - a.ageDays);

    const buckets = { '<1 day': 0, '1-3 days': 0, '3-7 days': 0, '>7 days': 0 };
    pending.forEach(q => {
      const ageMs = now - new Date(q.createdAt || now).getTime();
      const days = ageMs / (24 * 60 * 60 * 1000);
      if (days < 1) buckets['<1 day']++;
      else if (days < 3) buckets['1-3 days']++;
      else if (days < 7) buckets['3-7 days']++;
      else buckets['>7 days']++;
    });

    return {
      total: pending.length,
      buckets,
      agedCount: agedList.length,
      agedList
    };
  }, [questions, backlogAgeThreshold]);

  // --- §7: inter-rater agreement across double-reviewed items ---
  const agreement = useMemo(() => {
    let comparisons = 0;
    let matches = 0;
    let doubleReviewedCount = 0;
    let fullyValidatedCount = 0; // questions with MAX_CONSENSUS_REVIEWERS distinct reviews
    const fields: (keyof SATQuestion)[] = ['formationOk', 'answerOk', 'categoryOk', 'difficultyOk'];

    questions.forEach(q => {
      if (q.consensusReviews && q.consensusReviews.length >= MAX_CONSENSUS_REVIEWERS) {
        fullyValidatedCount++;
      }
      if (!q.requiresSecondReview || !q.consensusReviews || q.consensusReviews.length === 0) return;
      const hasPrimary = fields.some(f => (q as any)[f] !== null && (q as any)[f] !== undefined);
      if (!hasPrimary) return;
      doubleReviewedCount++;
      q.consensusReviews.forEach(review => {
        (['formationOk', 'answerOk', 'categoryOk', 'difficultyOk'] as const).forEach(field => {
          const primaryVal = (q as any)[field];
          const reviewVal = review[field];
          if (primaryVal === null || primaryVal === undefined || reviewVal === null || reviewVal === undefined) return;
          comparisons++;
          if (primaryVal === reviewVal) matches++;
        });
      });
    });

    return {
      doubleReviewedCount,
      fullyValidatedCount,
      comparisons,
      agreementPct: comparisons === 0 ? null : Math.round((matches / comparisons) * 100)
    };
  }, [questions]);

  // --- Daily Snapshot: admin day-at-a-glance view of a single day's activity ---
  const dailySnapshot = useMemo(() => {
    const dayLogs = fullDayLogs.length > 0
      ? fullDayLogs
      : logs.filter(l => l.rawTimestamp && toLocalDateKey(l.rawTimestamp) === snapshotDate);

    // Helper: logs array is sorted newest-first (index 0), so first decision match is the latest decision
    const getLatestDecision = (qLogs: AuditLogEntry[]): 'approved' | 'rejected' | 'needs_revision' | null => {
      for (let i = 0; i < qLogs.length; i++) {
        const l = qLogs[i];
        if (l.action === 'approve') return 'approved';
        if (l.action === 'reject') return 'rejected';
        if (isNeedsRevisionLog(l.description)) return 'needs_revision';
      }
      return null;
    };

    // Helper: extract numeric bulk count from log description strings if present (e.g. "Approved 116 items in bulk")
    const parseBulkCount = (desc: string): number => {
      const match = desc.match(/\b(?:approved|rejected|merged|cleared|restored|exported)\s+(\d+)\s+item/i) ||
        desc.match(/\b(\d+)\s+item\(s\)/i) ||
        desc.match(/\b(\d+)\s+question\(s\)/i);
      return match ? parseInt(match[1], 10) : 0;
    };

    // Group logs by questionId for overall day stats. Bulk approve/reject
    // actions log a single summary entry with no questionId (see
    // executeBulkConfirm), so they'd otherwise be silently dropped from every
    // count below — instead, tally the items they cover directly from the
    // log's own action + parsed count, keyed by the same action the bulk
    // action recorded.
    const dayLogsByQuestion = new Map<string, AuditLogEntry[]>();
    let bulkApprovedOverall = 0;
    let bulkRejectedOverall = 0;
    dayLogs.forEach(l => {
      if (!l.questionId) {
        const bCount = parseBulkCount(l.description);
        if (bCount > 0) {
          if (l.action === 'approve') bulkApprovedOverall += bCount;
          else if (l.action === 'reject') bulkRejectedOverall += bCount;
        }
        return;
      }
      if (!dayLogsByQuestion.has(l.questionId)) {
        dayLogsByQuestion.set(l.questionId, []);
      }
      dayLogsByQuestion.get(l.questionId)!.push(l);
    });

    let overallApproved = 0;
    let overallRejected = 0;
    let overallNeedsRevision = 0;

    dayLogsByQuestion.forEach((qLogs) => {
      const decision = getLatestDecision(qLogs);
      if (decision === 'approved') overallApproved++;
      else if (decision === 'rejected') overallRejected++;
      else if (decision === 'needs_revision') overallNeedsRevision++;
    });

    overallApproved += bulkApprovedOverall;
    overallRejected += bulkRejectedOverall;

    const claimed = dayLogs.filter(l => isClaimLog(l.description)).length;
    const comments = dayLogs.filter(l => isCommentLog(l.description)).length;
    const newQuestions = questions.filter(q => q.createdAt && toLocalDateKey(q.createdAt) === snapshotDate).length;

    // Per-validator breakdown: combine log evidence + direct question state (questions & batch2) + bulk counts
    const perValidatorLogs: Record<string, { total: number; questionLogs: Map<string, AuditLogEntry[]>; bulkApproved: number; bulkRejected: number }> = {};
    dayLogs.forEach(l => {
      const key = getCanonicalUserName(l);
      if (!perValidatorLogs[key]) {
        perValidatorLogs[key] = { total: 0, questionLogs: new Map(), bulkApproved: 0, bulkRejected: 0 };
      }
      perValidatorLogs[key].total += 1;
      if (l.questionId) {
        if (!perValidatorLogs[key].questionLogs.has(l.questionId)) {
          perValidatorLogs[key].questionLogs.set(l.questionId, []);
        }
        perValidatorLogs[key].questionLogs.get(l.questionId)!.push(l);
      } else {
        // Bulk action summary log — attribute its item count to the
        // validator using the log's own action (approve/reject), the same
        // way an individual decision would be, instead of a direction-less
        // bucket that later got shoehorned into whichever count was bigger.
        const bCount = parseBulkCount(l.description);
        if (bCount > 0) {
          if (l.action === 'approve') perValidatorLogs[key].bulkApproved += bCount;
          else if (l.action === 'reject') perValidatorLogs[key].bulkRejected += bCount;
        }
      }
    });

    // Also scan questions & batch2Questions for direct dataset matches for each validator today
    validators.forEach(val => {
      const name = val.name || val.email;
      const nameLower = name.trim().toLowerCase();

      // Check main Curator pool
      questions.forEach(q => {
        const isTouchedByVal =
          ((q as any).claimedByName && (q as any).claimedByName.trim().toLowerCase() === nameLower) ||
          ((q as any).assignedToName && (q as any).assignedToName.trim().toLowerCase() === nameLower) ||
          (q.consensusReviews && q.consensusReviews.some(r => r.validatorName?.trim().toLowerCase() === nameLower)) ||
          (q.comments && q.comments.some(c => c.author?.trim().toLowerCase() === nameLower));

        const qDate = (q as any).updatedAt || q.createdAt;
        if (isTouchedByVal && qDate && toLocalDateKey(qDate) === snapshotDate) {
          if (!perValidatorLogs[name]) {
            perValidatorLogs[name] = { total: 0, questionLogs: new Map(), bulkApproved: 0, bulkRejected: 0 };
          }
          if (!perValidatorLogs[name].questionLogs.has(q.id)) {
            perValidatorLogs[name].questionLogs.set(q.id, []);
          }
        }
      });

      // Check New Batch Workspace pool
      batch2Questions.forEach(b2 => {
        const isTouchedByVal =
          (b2.claimed_by_name && b2.claimed_by_name.trim().toLowerCase() === nameLower) ||
          (b2.assigned_to_name && b2.assigned_to_name.trim().toLowerCase() === nameLower) ||
          (b2.comments && b2.comments.some((c: any) => c.author?.trim().toLowerCase() === nameLower));

        const b2Date = b2.updated_at || b2.created_at;
        if (isTouchedByVal && b2Date && toLocalDateKey(b2Date) === snapshotDate) {
          if (!perValidatorLogs[name]) {
            perValidatorLogs[name] = { total: 0, questionLogs: new Map(), bulkApproved: 0, bulkRejected: 0 };
          }
          if (!perValidatorLogs[name].questionLogs.has(b2.id)) {
            perValidatorLogs[name].questionLogs.set(b2.id, []);
          }
        }
      });
    });

    const validatorRows = Object.entries(perValidatorLogs).map(([name, data]) => {
      let vApproved = 0;
      let vRejected = 0;
      let vNeedsRevision = 0;

      data.questionLogs.forEach((qLogs) => {
        const decision = getLatestDecision(qLogs);
        if (decision === 'approved') vApproved++;
        else if (decision === 'rejected') vRejected++;
        else if (decision === 'needs_revision') vNeedsRevision++;
      });

      vApproved += data.bulkApproved;
      vRejected += data.bulkRejected;

      const decidedCount = vApproved + vRejected + vNeedsRevision;
      const uniqueQuestions = decidedCount > 0 ? decidedCount : data.questionLogs.size;

      return {
        name,
        approved: vApproved,
        rejected: vRejected,
        needsRevision: vNeedsRevision,
        total: data.total,
        uniqueQuestions
      };
    }).sort((a, b) => b.uniqueQuestions - a.uniqueQuestions || b.total - a.total);

    const totalEvaluatedDecisions = validatorRows.reduce((sum, r) => sum + r.uniqueQuestions, 0);

    return {
      totalActions: dayLogs.length,
      uniqueQuestionsTotal: totalEvaluatedDecisions,
      approved: overallApproved,
      rejected: overallRejected,
      needsRevision: overallNeedsRevision,
      claimed,
      comments,
      newQuestions,
      activeValidatorCount: validatorRows.length,
      validatorRows
    };
  }, [fullDayLogs, logs, questions, batch2Questions, snapshotDate, userCanonicalNameMap, validators]);

  // --- Primary review vs. second-opinion disagreements awaiting admin resolution ---
  const disagreements = useMemo(() => {
    return questions
      .map(q => ({ question: q, resolution: getConsensusResolution(q) }))
      .filter(d => d.resolution.hasDisagreement);
  }, [questions]);

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    setSavedMsg(null);
    const patch = {
      rejection_webhook_url: webhookDraft.trim() || null,
      consensus_sample_rate: Math.min(100, Math.max(0, rateDraft)) / 100
    };
    const { error } = await supabase.from('app_settings').update(patch).eq('id', 1);
    setSavingSettings(false);
    if (!error) {
      onSettingsSaved(patch as any);
      setSavedMsg('Saved.');
      setTimeout(() => setSavedMsg(null), 2500);
    } else {
      setSavedMsg(`Failed: ${error.message}`);
    }
  };

  return (
    <div className="flex flex-col gap-6 font-sans">
      {/* 1. VALIDATOR ACCOUNTS & INVITES */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Active Validators List */}
        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl overflow-hidden shadow-sm">
          <div className="px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-indigo-600" />
              <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">Active Validators</h4>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-zinc-500 bg-white px-2.5 py-0.5 rounded-full border border-[#e4e4e7]">{validators.length} accounts</span>
              {onOpenValidatorProgress && (
                <button
                  onClick={onOpenValidatorProgress}
                  title="Export a validator's (or all validators') daily progress report"
                  className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold rounded-md border border-violet-700 bg-violet-700 hover:bg-violet-600 text-white shadow-xs transition-all cursor-pointer"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> Export Progress
                </button>
              )}
            </div>
          </div>
          <div className="divide-y divide-[#e4e4e7] max-h-72 overflow-y-auto bg-[#fafafa]">
            {validators.map(v => (
              <div key={v.id} className="flex items-center gap-3 px-5 py-3.5 text-xs hover:bg-[#f7f7f7] transition-all">
                <div className="flex-1 min-w-0">
                  <p className="text-zinc-700 font-semibold truncate">{v.name || v.email}</p>
                  <p className="text-zinc-600 truncate font-mono text-[12px]">{v.email}</p>
                </div>
                <select
                  defaultValue={v.role}
                  onChange={(e) => updateValidator(v.id, { role: e.target.value as Profile['role'] })}
                  className="bg-white border border-[#e4e4e7] rounded-md px-2 py-1.5 text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-600 cursor-pointer"
                >
                  <option value="validator">Validator</option>
                  <option value="admin">Admin</option>
                  <option value="auditor">Auditor (read-only)</option>
                </select>
                <button
                  onClick={() => updateValidator(v.id, { active: !v.active })}
                  className={`px-2.5 py-1.5 rounded-md border font-bold transition-all cursor-pointer ${v.active
                    ? 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'
                    : 'border-rose-200 text-rose-600 hover:bg-rose-50'
                    }`}
                  title={v.active ? 'Click to deactivate validator' : 'Click to reactivate validator'}
                >
                  {v.active ? 'Active' : 'Disabled'}
                </button>
              </div>
            ))}
            {validators.length === 0 && (
              <div className="px-5 py-6 text-xs text-zinc-600 text-center">No active validator profiles found.</div>
            )}
          </div>
        </div>

        {/* Invite Validator Form & Pending invites */}
        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl overflow-hidden shadow-sm flex flex-col justify-between">
          <div>
            <div className="px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3] flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-indigo-600" />
              <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">Invite New Validator</h4>
            </div>

            {/* Invite Form */}
            <form onSubmit={handleSendInvite} className="p-5 flex flex-col gap-3.5 border-b border-[#e4e4e7] bg-[#f6f6f6]">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Email Address</label>
                  <input
                    type="email"
                    required
                    placeholder="validator@example.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="bg-white border border-[#e4e4e7] rounded-lg px-3 py-2 text-xs text-zinc-700 focus:outline-none focus:ring-1 focus:ring-indigo-600 placeholder:text-zinc-500"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Validator Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Sarah Jenkins"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    className="bg-white border border-[#e4e4e7] rounded-lg px-3 py-2 text-xs text-zinc-700 focus:outline-none focus:ring-1 focus:ring-indigo-600 placeholder:text-zinc-500"
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Assigned Role:</label>
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as any)}
                    className="bg-white border border-[#e4e4e7] rounded-lg px-3 py-1.5 text-xs text-zinc-700 focus:outline-none focus:ring-1 focus:ring-indigo-600 cursor-pointer"
                  >
                    <option value="validator">Validator</option>
                    <option value="admin">Admin</option>
                    <option value="auditor">Auditor (read-only)</option>
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={inviting}
                  className="ml-auto flex items-center gap-1.5 px-4 py-2 bg-[#6366f1] hover:bg-indigo-700 text-white text-xs font-bold rounded-lg transition-all cursor-pointer disabled:opacity-60"
                >
                  <UserPlus className="w-3.5 h-3.5" /> {inviting ? 'Inviting…' : 'Add Pre-auth Invite'}
                </button>
              </div>
              {inviteError && (
                <div className="text-[12px] text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" /> {inviteError}
                </div>
              )}
            </form>
          </div>

          {/* Invited — Awaiting Sign-In: accounts already created via the
              emailed invite (so they're already active validators/admins/
              auditors), but who haven't clicked the email link and set a
              password yet. Distinct from the pre-authorization list below,
              which is emptied the instant an invite email is sent. */}
          <div className="border-b border-[#e4e4e7] bg-[#fafafa]">
            <div className="px-5 py-2.5 border-b border-[#e4e4e7] bg-[#f5f5f5] text-[11px] uppercase font-bold text-zinc-500 tracking-wider">
              Invited — Awaiting Sign-In
            </div>
            <div className="divide-y divide-[#e4e4e7] max-h-40 overflow-y-auto">
              {validators.filter(v => v.invite_pending).map(v => (
                <div key={v.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-xs hover:bg-[#f7f7f7] transition-all">
                  <div className="truncate pr-2">
                    <p className="text-zinc-600 font-semibold truncate">{v.name || v.email}</p>
                    <p className="text-zinc-600 text-[11px] font-mono truncate">{v.email} • Role: {v.role}</p>
                  </div>
                  <span className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-md whitespace-nowrap">
                    Email sent
                  </span>
                </div>
              ))}
              {validators.filter(v => v.invite_pending).length === 0 && (
                <div className="px-5 py-4 text-[12px] text-zinc-600 italic text-center">No one is currently waiting to accept an invite.</div>
              )}
            </div>
          </div>

          {/* Pre-Authorized (Not Yet Signed Up): whitelist rows for people who
              haven't been sent an invite email yet, or whose invite email
              failed to send — they can still self-register with this exact
              email and be auto-approved. */}
          <div className="flex-1 bg-[#fafafa]">
            <div className="px-5 py-2.5 border-b border-[#e4e4e7] bg-[#f5f5f5] text-[11px] uppercase font-bold text-zinc-500 tracking-wider">
              Pre-Authorized (Not Yet Signed Up)
            </div>
            <div className="divide-y divide-[#e4e4e7] max-h-40 overflow-y-auto">
              {invites.map(invite => (
                <div key={invite.email} className="flex items-center justify-between gap-3 px-5 py-2.5 text-xs hover:bg-[#f7f7f7] transition-all">
                  <div className="truncate pr-2">
                    <p className="text-zinc-600 font-semibold truncate">{invite.name}</p>
                    <p className="text-zinc-600 text-[11px] font-mono truncate">{invite.email} • Role: {invite.role}</p>
                  </div>
                  <button
                    onClick={() => handleCancelInvite(invite.email)}
                    className="p-1.5 text-zinc-500 hover:text-rose-600 border border-[#e4e4e7] hover:bg-rose-50 rounded-md transition-all cursor-pointer bg-white"
                    title="Cancel invite pre-authorization"
                  >
                    <Trash className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              {invites.length === 0 && (
                <div className="px-5 py-4 text-[12px] text-zinc-600 italic text-center">No pending pre-authorizations. If an invite email sends successfully, it moves to "Awaiting Sign-In" above right away.</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 2. DAILY THROUGHPUT ANALYTICS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 14-day Throughput Summary Chart */}
        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl overflow-hidden shadow-sm lg:col-span-1">
          <div className="px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3] flex items-center gap-2">
            <Activity className="w-4 h-4 text-sky-600" />
            <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">Throughput Summary (14d)</h4>
          </div>
          <div className="p-5 flex flex-col gap-3">
            {throughputSummary.length === 0 && <p className="text-xs text-zinc-600 italic">No approve/reject activity logged yet.</p>}
            {throughputSummary.map(([name, count]) => (
              <div key={name} className="flex items-center gap-3">
                <span className="text-xs text-zinc-600 w-28 truncate shrink-0">{name}</span>
                <div className="flex-1 h-2 bg-white rounded-full overflow-hidden border border-[#e4e4e7]">
                  <div className="h-full bg-sky-500 rounded-full" style={{ width: `${(count / maxThroughputSummary) * 100}%` }} />
                </div>
                <span className="text-[12px] font-mono text-zinc-500 w-8 text-right shrink-0">{count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Daily Breakdown List (Throughput per validator, per day) */}
        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl overflow-hidden shadow-sm lg:col-span-2 flex flex-col justify-between">
          <div className="px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-sky-600" />
              <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">Daily Throughput Details</h4>
            </div>
            <span className="font-mono text-[11px] text-zinc-500 bg-white px-2.5 py-0.5 rounded-full border border-[#e4e4e7]">Per Validator / Per Day</span>
          </div>
          <div className="max-h-80 overflow-y-auto overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="sticky top-0 bg-[#f5f5f5] z-10">
                <tr className="border-b border-[#e4e4e7] text-zinc-500 font-bold uppercase tracking-wider text-[11px] select-none">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Validator / Curator</th>
                  <th className="px-5 py-3 text-center">Unique Questions</th>
                  <th className="px-5 py-3 text-right">Log Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e4e4e7] bg-[#fafafa]">
                {dailyThroughput.map((row, idx) => (
                  <tr key={idx} className="hover:bg-[#f7f7f7] transition-all">
                    <td className="px-5 py-3 font-mono text-zinc-500">{row.displayDate}</td>
                    <td className="px-5 py-3 text-zinc-700 font-semibold">{row.user}</td>
                    <td className="px-5 py-3 text-center text-sky-600 font-mono font-bold">{row.uniqueQuestions} items</td>
                    <td className="px-5 py-3 text-right text-zinc-500 font-mono text-[11px]">{row.actions} actions</td>
                  </tr>
                ))}
                {dailyThroughput.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-8 text-center text-zinc-600 italic">No daily curation logs found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 2B. DAILY SNAPSHOT — admin day-at-a-glance view */}
      <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-indigo-600" />
            <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">Daily Snapshot</h4>
          </div>
          <div className="flex items-center gap-2 bg-white border border-[#e4e4e7] rounded-lg px-2.5 py-1 select-none">
            <span className="text-[12px] text-zinc-500 font-semibold">Date:</span>
            <input
              type="date"
              value={snapshotDate}
              max={todayKey()}
              onChange={(e) => setSnapshotDate(e.target.value)}
              className="bg-transparent border-none text-[12px] text-zinc-700 font-bold font-mono focus:outline-none"
            />
          </div>
        </div>

        <div className="p-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 border-b border-[#e4e4e7] bg-[#f7f7f7]">
          <div className="flex flex-col gap-1 p-3 bg-white border border-[#e4e4e7] rounded-xl text-center">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mx-auto" />
            <span className="text-2xl font-extrabold text-emerald-600 font-mono mt-0.5">{dailySnapshot.approved}</span>
            <span className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider">Approved</span>
          </div>
          <div className="flex flex-col gap-1 p-3 bg-white border border-[#e4e4e7] rounded-xl text-center">
            <XCircle className="w-3.5 h-3.5 text-rose-600 mx-auto" />
            <span className="text-2xl font-extrabold text-rose-600 font-mono mt-0.5">{dailySnapshot.rejected}</span>
            <span className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider">Rejected</span>
          </div>
          <div className="flex flex-col gap-1 p-3 bg-white border border-[#e4e4e7] rounded-xl text-center">
            <RotateCcw className="w-3.5 h-3.5 text-amber-700 mx-auto" />
            <span className="text-2xl font-extrabold text-amber-700 font-mono mt-0.5">{dailySnapshot.needsRevision}</span>
            <span className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider">Needs Revision</span>
          </div>
          <div className="flex flex-col gap-1 p-3 bg-white border border-[#e4e4e7] rounded-xl text-center">
            <ListPlus className="w-3.5 h-3.5 text-sky-600 mx-auto" />
            <span className="text-2xl font-extrabold text-sky-600 font-mono mt-0.5">{dailySnapshot.newQuestions}</span>
            <span className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider">New Items</span>
          </div>
          <div className="flex flex-col gap-1 p-3 bg-white border border-[#e4e4e7] rounded-xl text-center">
            <MessageSquare className="w-3.5 h-3.5 text-violet-400 mx-auto" />
            <span className="text-2xl font-extrabold text-violet-400 font-mono mt-0.5">{dailySnapshot.comments}</span>
            <span className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider">Comments</span>
          </div>
          <div className="flex flex-col gap-1 p-3 bg-white border border-[#e4e4e7] rounded-xl text-center">
            <Activity className="w-3.5 h-3.5 text-zinc-500 mx-auto" />
            <span className="text-2xl font-extrabold text-zinc-900 font-mono mt-0.5">{dailySnapshot.totalActions}</span>
            <span className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider">Total Actions</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-[#f5f5f5] border-b border-[#e4e4e7] text-zinc-500 font-bold uppercase tracking-wider text-[11px] select-none">
                <th className="px-5 py-3">Validator / Curator</th>
                <th className="px-5 py-3 text-center">Questions Evaluated</th>
                <th className="px-5 py-3 text-center">Approved</th>
                <th className="px-5 py-3 text-center">Rejected</th>
                <th className="px-5 py-3 text-center">Needs Revision</th>
                <th className="px-5 py-3 text-right">Total Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e4e4e7] bg-[#fafafa]">
              {dailySnapshot.validatorRows.map((row, idx) => (
                <tr key={idx} className="hover:bg-[#f7f7f7] transition-all">
                  <td className="px-5 py-3 text-zinc-700 font-semibold">{row.name}</td>
                  <td className="px-5 py-3 text-center font-mono text-indigo-600 font-bold">{row.uniqueQuestions}</td>
                  <td className="px-5 py-3 text-center font-mono text-emerald-600 font-bold">{row.approved}</td>
                  <td className="px-5 py-3 text-center font-mono text-rose-600 font-bold">{row.rejected}</td>
                  <td className="px-5 py-3 text-center font-mono text-amber-700 font-bold">{row.needsRevision}</td>
                  <td className="px-5 py-3 text-right text-zinc-500 font-mono text-[11px]">{row.total}</td>
                </tr>
              ))}
              {dailySnapshot.validatorRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-zinc-600 italic">
                    No activity logged for {new Date(`${snapshotDate}T00:00:00`).toLocaleDateString()}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {dailySnapshot.validatorRows.length > 0 && (
          <div className="px-5 py-2.5 border-t border-[#e4e4e7] bg-[#f6f6f6] text-[11px] text-zinc-600 text-center font-mono select-none">
            {dailySnapshot.activeValidatorCount} validator(s) active on {new Date(`${snapshotDate}T00:00:00`).toLocaleDateString()} • {dailySnapshot.uniqueQuestionsTotal} unique question(s) evaluated
          </div>
        )}
      </div>

      {/* 3. PASS/FAIL/REVISION RATES */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Rates by Category */}
        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl overflow-hidden shadow-sm">
          <div className="px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3] flex items-center gap-2">
            <Percent className="w-4 h-4 text-emerald-600" />
            <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">Pass/Fail/Revision Rates (Category)</h4>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-[#f5f5f5] border-b border-[#e4e4e7] text-zinc-500 font-bold uppercase tracking-wider text-[11px] select-none">
                  <th className="px-5 py-3">Category Domain</th>
                  <th className="px-5 py-3 text-center">Pass %</th>
                  <th className="px-5 py-3 text-center">Fail %</th>
                  <th className="px-5 py-3 text-center">Revision %</th>
                  <th className="px-5 py-3 text-right">Total Items</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e4e4e7] bg-[#fafafa]">
                {statusRates.categoryRates.map((row, idx) => (
                  <tr key={idx} className="hover:bg-[#f7f7f7] transition-all">
                    <td className="px-5 py-3 text-zinc-700 font-semibold truncate max-w-37.5" title={row.name}>{row.name}</td>
                    <td className="px-5 py-3 text-center font-mono text-emerald-600 font-bold">{row.rates.pass}%</td>
                    <td className="px-5 py-3 text-center font-mono text-rose-600 font-bold">{row.rates.fail}%</td>
                    <td className="px-5 py-3 text-center font-mono text-amber-700 font-bold">{row.rates.revision}%</td>
                    <td className="px-5 py-3 text-right text-zinc-500 font-mono">{row.stats.total}</td>
                  </tr>
                ))}
                {statusRates.categoryRates.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-6 text-center text-zinc-600 italic">No questions found in dataset.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Rates by Difficulty */}
        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl overflow-hidden shadow-sm">
          <div className="px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3] flex items-center gap-2">
            <Percent className="w-4 h-4 text-emerald-600" />
            <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">Pass/Fail/Revision Rates (Difficulty)</h4>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-[#f5f5f5] border-b border-[#e4e4e7] text-zinc-500 font-bold uppercase tracking-wider text-[11px] select-none">
                  <th className="px-5 py-3">Difficulty Level</th>
                  <th className="px-5 py-3 text-center">Pass %</th>
                  <th className="px-5 py-3 text-center">Fail %</th>
                  <th className="px-5 py-3 text-center">Revision %</th>
                  <th className="px-5 py-3 text-right">Total Items</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e4e4e7] bg-[#fafafa]">
                {statusRates.difficultyRates.map((row, idx) => (
                  <tr key={idx} className="hover:bg-[#f7f7f7] transition-all capitalize">
                    <td className="px-5 py-3 text-zinc-700 font-semibold">{row.name}</td>
                    <td className="px-5 py-3 text-center font-mono text-emerald-600 font-bold">{row.rates.pass}%</td>
                    <td className="px-5 py-3 text-center font-mono text-rose-600 font-bold">{row.rates.fail}%</td>
                    <td className="px-5 py-3 text-center font-mono text-amber-700 font-bold">{row.rates.revision}%</td>
                    <td className="px-5 py-3 text-right text-zinc-500 font-mono">{row.stats.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 4. CONFIGURABLE BACKLOG AGING */}
      <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-700" />
            <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">Backlog Size &amp; Aging Queue</h4>
          </div>
          <div className="flex items-center gap-2 bg-white border border-[#e4e4e7] rounded-lg px-2.5 py-1 select-none">
            <span className="text-[12px] text-zinc-500 font-semibold">Age threshold:</span>
            <input
              type="number"
              min={1}
              max={30}
              value={backlogAgeThreshold}
              onChange={(e) => setBacklogAgeThreshold(Math.max(1, Number(e.target.value)))}
              className="w-12 bg-transparent border-none text-[12px] text-amber-700 font-bold font-mono focus:outline-none text-center"
            />
            <span className="text-[12px] text-zinc-500 font-semibold">day(s)</span>
          </div>
        </div>

        <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-6 border-b border-[#e4e4e7] bg-[#f7f7f7]">
          <div className="flex flex-col gap-1 p-3 bg-white border border-[#e4e4e7] rounded-xl text-center">
            <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Total Pending Backlog</span>
            <span className="text-3xl font-extrabold text-zinc-900 font-mono mt-0.5">{agingBacklog.total}</span>
            <span className="text-[11px] text-zinc-600 font-medium">unresolved test items</span>
          </div>
          <div className="flex flex-col gap-1 p-3 bg-white border border-[#e4e4e7] rounded-xl text-center">
            <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Aged Queue (&gt; {backlogAgeThreshold} days)</span>
            <span className="text-3xl font-extrabold text-amber-700 font-mono mt-0.5">{agingBacklog.agedCount}</span>
            <span className="text-[11px] text-zinc-600 font-medium">{Math.round((agingBacklog.agedCount / Math.max(1, agingBacklog.total)) * 100)}% of backlog</span>
          </div>
          <div className="flex flex-col gap-2 p-3 bg-white border border-[#e4e4e7] rounded-xl select-none">
            <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider text-center">Age Cohorts</span>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] text-zinc-500 font-mono px-3 mt-1">
              {Object.entries(agingBacklog.buckets).map(([bucket, count]) => (
                <div key={bucket} className="flex justify-between">
                  <span>{bucket}:</span>
                  <span className="font-bold text-zinc-900">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Aging items detail list */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-[#f5f5f5] border-b border-[#e4e4e7] text-zinc-500 font-bold uppercase tracking-wider text-[11px] select-none">
                <th className="px-5 py-3">Question ID</th>
                <th className="px-5 py-3">Domain category</th>
                <th className="px-5 py-3 text-center">Difficulty</th>
                <th className="px-5 py-3">Assigned validator</th>
                <th className="px-5 py-3 text-right">Age (in days)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e4e4e7] bg-[#fafafa]">
              {agingBacklog.agedList.map((row, idx) => (
                <tr key={idx} className="hover:bg-[#f7f7f7] transition-all">
                  <td className="px-5 py-3 font-mono text-indigo-600 font-semibold select-all">{row.id}</td>
                  <td className="px-5 py-3 text-zinc-700">{row.category}</td>
                  <td className="px-5 py-3 text-center capitalize">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold font-mono border ${row.difficulty === 'easy' ? 'bg-blue-50 text-blue-600 border-blue-200' :
                      row.difficulty === 'hard' ? 'bg-rose-50 text-rose-600 border-rose-200' :
                        'bg-amber-50 text-amber-700 border-amber-200'
                      }`}>
                      {row.difficulty}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-zinc-600 font-medium">{row.assignedToName}</td>
                  <td className="px-5 py-3 text-right text-amber-500 font-mono font-extrabold">{row.ageDays} day(s) old</td>
                </tr>
              ))}
              {agingBacklog.agedList.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-zinc-600 italic">No pending items are older than {backlogAgeThreshold} days.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Primary review vs. second-opinion disagreements — admin resolution queue */}
      <div className="bg-[#fafafa] border border-amber-200 rounded-xl overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-amber-200 bg-amber-50 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-700" />
          <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">
            Consensus Disagreements — Needs Admin Resolution
          </h4>
          {disagreements.length > 0 && (
            <span className="ml-auto font-mono text-[11px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
              {disagreements.length} open
            </span>
          )}
        </div>
        <div className="p-5">
          {disagreements.length === 0 ? (
            <p className="text-xs text-zinc-600 italic text-center py-4">
              No open disagreements — every double-reviewed item's primary reviewer and second opinions currently agree.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {disagreements.map(({ question: q, resolution }) => {
                const label = (v: 'approved' | 'needs_revision' | 'pending') =>
                  v === 'approved' ? 'Approved' : v === 'needs_revision' ? 'Needs Revision' : 'Pending';
                return (
                  <div key={q.id} className="border border-[#e4e4e7] rounded-lg p-3.5 bg-white flex flex-col gap-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-bold text-zinc-900">{q.id}</p>
                        <p className="text-[12px] text-zinc-500 mt-0.5 line-clamp-1">{q.question}</p>
                      </div>
                      <span className="shrink-0 text-[11px] font-mono text-zinc-500 bg-[#fafafa] border border-[#e4e4e7] rounded-full px-2 py-0.5">
                        {q.category}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[12px]">
                      <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-lg px-2.5 py-2">
                        <p className="text-zinc-500 uppercase font-bold tracking-wider text-[11px]">Primary reviewer</p>
                        <p className={`font-bold mt-0.5 ${resolution.primaryVerdict === 'approved' ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {label(resolution.primaryVerdict)}
                        </p>
                        {q.claimedByName && <p className="text-zinc-600 mt-0.5">{q.claimedByName}</p>}
                      </div>
                      <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-lg px-2.5 py-2">
                        <p className="text-zinc-500 uppercase font-bold tracking-wider text-[11px]">Second opinions</p>
                        <p className={`font-bold mt-0.5 ${resolution.secondOpinionVerdict === 'approved' ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {resolution.secondOpinionVerdict ? label(resolution.secondOpinionVerdict) : '—'}
                        </p>
                        <p className="text-zinc-600 mt-0.5">
                          {resolution.secondOpinionApproved} approved / {resolution.secondOpinionNeedsRevision} needs revision
                          {resolution.secondOpinions.length > 0 && (
                            <> — {resolution.secondOpinions.map(r => r.validatorName).join(', ')}</>
                          )}
                        </p>
                      </div>
                    </div>
                    {onResolveConsensus && (
                      <div className="flex flex-wrap gap-2 justify-end pt-1">
                        <button
                          onClick={() => onResolveConsensus(q.id, 'primary')}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold rounded-lg border border-[#e4e4e7] bg-[#fafafa] text-zinc-600 hover:bg-[#e4e4e7] hover:text-zinc-900 transition-all cursor-pointer"
                        >
                          Keep Primary ({label(resolution.primaryVerdict)})
                        </button>
                        <button
                          onClick={() => onResolveConsensus(q.id, 'second_opinion')}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-bold rounded-lg border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-900 hover:text-white transition-all cursor-pointer"
                        >
                          Apply Second Opinions ({resolution.secondOpinionVerdict ? label(resolution.secondOpinionVerdict) : ''})
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 5. AGREEMENT & SETTINGS ROW */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Inter-Rater Agreement */}
        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl overflow-hidden shadow-sm lg:col-span-1 flex flex-col justify-between">
          <div className="px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3] flex items-center gap-2">
            <Scale className="w-4 h-4 text-violet-400" />
            <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">Inter-Rater Agreement</h4>
          </div>
          <div className="p-5 flex items-center gap-6 bg-[#fafafa] flex-1">
            <div className="shrink-0 text-center">
              <p className="text-3xl font-extrabold text-violet-400 font-mono">
                {agreement.agreementPct === null ? '—' : `${agreement.agreementPct}%`}
              </p>
              <p className="text-[11px] text-zinc-500 mt-1 font-mono uppercase font-bold tracking-wider">agreement rate</p>
            </div>
            <div className="text-xs text-zinc-500 leading-normal border-l border-[#e4e4e7] pl-6 py-1.5">
              Matches decisions across <strong>{agreement.comparisons}</strong> validation check fields on double-reviewed items. Flagged double-reviewed questions are sampled at a rate of <strong>{Math.round((settings.consensus_sample_rate || 0.1) * 100)}%</strong>.
            </div>
            <div className="shrink-0 text-center border-l border-[#e4e4e7] pl-6">
              <p className="text-3xl font-extrabold text-emerald-600 font-mono">{agreement.fullyValidatedCount}</p>
              <p className="text-[11px] text-zinc-500 mt-1 font-mono uppercase font-bold tracking-wider">
                fully validated ({MAX_CONSENSUS_REVIEWERS}/{MAX_CONSENSUS_REVIEWERS})
              </p>
            </div>
          </div>
        </div>

        {/* Rejection Webhook & Sample Rate settings */}
        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl overflow-hidden shadow-sm lg:col-span-2">
          <div className="px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3] flex items-center gap-2">
            <Webhook className="w-4 h-4 text-emerald-600" />
            <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">System Settings Configuration</h4>
          </div>
          <div className="p-5 flex flex-col gap-4">
            <div>
              <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider block mb-1.5">Rejection feedback webhook URL</label>
              <input
                type="text"
                value={webhookDraft}
                onChange={(e) => setWebhookDraft(e.target.value)}
                placeholder="https://your-generator-pipeline.example.com/webhooks/rejected"
                className="w-full bg-white border border-[#e4e4e7] rounded-lg px-3 py-2 text-xs text-zinc-700 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-emerald-600"
              />
              <p className="text-[12px] text-zinc-600 mt-1.5 leading-normal">
                Webhook endpoint called when rejections occur, carrying curator notes/comments back to the generator agent to prompt retraining. Leave blank to disable.
              </p>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-[#e4e4e7] pt-4">
              <div className="flex flex-col gap-0.5">
                <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Consensus double-review sample rate</label>
                <p className="text-[12px] text-zinc-600 leading-normal">Ratios of imported items getting automatically selected for a second check.</p>
              </div>
              <div className="flex items-center gap-2 bg-white border border-[#e4e4e7] rounded-lg px-3 py-1.5 shrink-0 select-none">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={rateDraft}
                  onChange={(e) => setRateDraft(Number(e.target.value))}
                  className="w-12 bg-transparent border-none text-xs text-emerald-600 font-bold font-mono focus:outline-none text-center"
                />
                <span className="text-xs text-zinc-500 font-semibold">%</span>
              </div>
            </div>
            <div className="flex items-center gap-3 border-t border-[#e4e4e7] pt-4">
              <button
                onClick={handleSaveSettings}
                disabled={savingSettings}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-600 hover:bg-emerald-900 hover:text-white transition-all cursor-pointer disabled:opacity-60"
              >
                <Save className="w-3.5 h-3.5" /> {savingSettings ? 'Saving Settings…' : 'Save System Settings'}
              </button>
              {savedMsg && <span className="text-[12px] text-zinc-500 font-mono font-semibold">{savedMsg}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}