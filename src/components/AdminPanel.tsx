import { useState, useMemo, useEffect } from 'react';
import { ShieldCheck, Users, Activity, Clock, Scale, Save, Webhook, UserPlus, Trash, Calendar, Percent, AlertCircle, AlertTriangle } from 'lucide-react';
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
}

export default function AdminPanel({
  questions,
  logs,
  validators,
  invites,
  onRefreshInvites,
  onRefreshValidators,
  settings,
  onSettingsSaved,
  onResolveConsensus
}: AdminPanelProps) {
  const [webhookDraft, setWebhookDraft] = useState(settings.rejection_webhook_url || '');
  const [rateDraft, setRateDraft] = useState(Math.round((settings.consensus_sample_rate || 0.1) * 100));
  const [savingSettings, setSavingSettings] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

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

  // --- §9: throughput per validator per day (all time approve/reject actions) ---
  const dailyThroughput = useMemo(() => {
    const dailyMap: Record<string, Record<string, number>> = {};
    logs.forEach(l => {
      if (!l.rawTimestamp || (l.action !== 'approve' && l.action !== 'reject')) return;
      const dateKey = new Date(l.rawTimestamp).toLocaleDateString();
      const userKey = l.user || 'Unknown Curator';
      if (!dailyMap[dateKey]) {
        dailyMap[dateKey] = {};
      }
      dailyMap[dateKey][userKey] = (dailyMap[dateKey][userKey] || 0) + 1;
    });

    const entries: { date: string; user: string; count: number }[] = [];
    Object.entries(dailyMap).forEach(([date, userMap]) => {
      Object.entries(userMap).forEach(([user, count]) => {
        entries.push({ date, user, count });
      });
    });

    // Sort by date descending
    return entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [logs]);

  // --- §9: throughput per validator (last 14 days summary) ---
  const throughputSummary = useMemo(() => {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const byValidator: Record<string, number> = {};
    logs.forEach(l => {
      if (!l.rawTimestamp || (l.action !== 'approve' && l.action !== 'reject')) return;
      if (new Date(l.rawTimestamp).getTime() < cutoff) return;
      const key = l.user || 'Unknown';
      byValidator[key] = (byValidator[key] || 0) + 1;
    });
    return Object.entries(byValidator).sort((a, b) => b[1] - a[1]);
  }, [logs]);
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
  const maxBacklogBucket = Math.max(1, ...Object.values(agingBacklog.buckets));

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
            <span className="font-mono text-[12px] text-zinc-500 bg-white px-2.5 py-0.5 rounded-full border border-[#e4e4e7]">{validators.length} accounts</span>
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
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-[#f5f5f5] border-b border-[#e4e4e7] text-zinc-500 font-bold uppercase tracking-wider text-[11px] select-none">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Validator / Curator</th>
                  <th className="px-5 py-3 text-right">Throughput count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e4e4e7] bg-[#fafafa]">
                {dailyThroughput.slice(0, 10).map((row, idx) => (
                  <tr key={idx} className="hover:bg-[#f7f7f7] transition-all">
                    <td className="px-5 py-3 font-mono text-zinc-500">{row.date}</td>
                    <td className="px-5 py-3 text-zinc-700 font-semibold">{row.user}</td>
                    <td className="px-5 py-3 text-right text-sky-600 font-mono font-bold">{row.count} verdicts</td>
                  </tr>
                ))}
                {dailyThroughput.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-5 py-8 text-center text-zinc-600 italic">No daily curation logs found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {dailyThroughput.length > 10 && (
            <div className="px-5 py-2.5 border-t border-[#e4e4e7] bg-[#f6f6f6] text-[11px] text-zinc-600 text-center font-mono select-none">
              Showing top 10 daily summaries
            </div>
          )}
        </div>
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
                    <td className="px-5 py-3 text-zinc-700 font-semibold truncate max-w-[150px]" title={row.name}>{row.name}</td>
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