import { useState, useMemo, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { X, FileSpreadsheet, CalendarDays, User as UserIcon, CalendarRange } from 'lucide-react';
import { SATQuestion, QuestionComment } from '../types';
import { supabase, Profile } from '../lib/supabaseClient';
import { AuditLogEntry } from './AuditActivityLogs';

// Lightweight metadata for New Batch (questions_batch2) questions — this
// modal only ever received the main Curator `questions` table as a prop, so
// any validator activity that happened in the New Batch tab resolved to an
// undefined question and exported with blank Subject/Domain/Sub
// Skill/Difficulty and a hardcoded "pending" status. This fetches just
// enough columns from questions_batch2 to fill those gaps.
interface Batch2Meta {
  category?: string;
  subSkill?: string;
  section?: string;
  module?: string;
  difficulty?: string;
  reviewStatus?: string;
  comments?: QuestionComment[];
}

interface ValidatorProgressModalProps {
  isOpen: boolean;
  onClose: () => void;
  validators: Profile[];
  questions: SATQuestion[];
  logs: AuditLogEntry[];
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

// --- Per-action classification tags, matched against the exact description
// strings App.tsx's logEvent() calls already write (see handleApprove,
// handleReject, handleClaim, handleSetCheck, handleManualOverride,
// handleAddComment). Kept as small standalone regexes so new log phrasing
// elsewhere doesn't silently break the whole report. ---
const isClaim = (d: string) => /claimed item ".*?" for review/i.test(d);
const isRelease = (d: string) => /released the claim on item/i.test(d);
const isFinalApprove = (d: string) =>
  /^Approved item /.test(d) || /overrode overall status of item ".*?" to "approved"/i.test(d);
const isFinalReject = (d: string) =>
  /^Rejected item /.test(d) || /overrode overall status of item ".*?" to "rejected"/i.test(d);
const isNeedsRevision = (d: string) =>
  /overall status now needs revision/i.test(d) || /overrode overall status of item ".*?" to "needs_revision"/i.test(d);
const isComment = (d: string) => /commented on item/i.test(d);
// NewBatchWorkspace.tsx's logEvent() prefixes every description with
// "[New Batch] ". isFinalApprove/isFinalReject match with a ^ anchor, so
// without stripping this prefix first, New Batch approvals/rejections never
// matched and silently fell through to the generic 'Edited' tag instead.
const stripBatchPrefix = (d: string) => d.replace(/^\[New Batch\]\s*/, '');

// yyyy-mm-dd in India Standard Time (Asia/Kolkata) — matches AdminPanel.tsx timezone handling
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

const sanitizeSheetName = (name: string) =>
  name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Validator';

interface QuestionActivity {
  questionId: string;
  tags: Set<string>;
  lastActionAt: string;
}

export default function ValidatorProgressModal({
  isOpen,
  onClose,
  validators,
  questions,
  logs,
  showToast
}: ValidatorProgressModalProps) {
  const [selectedValidator, setSelectedValidator] = useState<string>('all');
  const [rangeMode, setRangeMode] = useState<'single' | 'range'>('single');
  const [selectedDate, setSelectedDate] = useState<string>(todayKey());
  const [rangeStart, setRangeStart] = useState<string>(todayKey());
  const [rangeEnd, setRangeEnd] = useState<string>(todayKey());

  const questionById = useMemo(() => {
    const map = new Map<string, SATQuestion>();
    questions.forEach(q => map.set(q.id, q));
    return map;
  }, [questions]);

  const [batch2ById, setBatch2ById] = useState<Map<string, Batch2Meta>>(new Map());
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    supabase
      .from('questions_batch2')
      .select('id, category, sub_skill, section, module, difficulty, review_status, comments')
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        const map = new Map<string, Batch2Meta>();
        data.forEach((row: any) => map.set(row.id, {
          category: row.category,
          subSkill: row.sub_skill || undefined,
          section: row.section || undefined,
          module: row.module || undefined,
          difficulty: row.difficulty || undefined,
          reviewStatus: row.review_status || undefined,
          comments: row.comments || []
        }));
        setBatch2ById(map);
      });
    return () => { cancelled = true; };
  }, [isOpen]);

  if (!isOpen) return null;

  // Normalized range bounds — swap if the user picked them backwards, and
  // collapse to a single day when in 'single' mode so all downstream logic
  // can share one code path.
  const rangeBounds = (() => {
    if (rangeMode === 'single') return { from: selectedDate, to: selectedDate };
    const from = rangeStart <= rangeEnd ? rangeStart : rangeEnd;
    const to = rangeStart <= rangeEnd ? rangeEnd : rangeStart;
    return { from, to };
  })();

  const isDateInRange = (dateKey: string) => dateKey >= rangeBounds.from && dateKey <= rangeBounds.to;

  // Human-readable label for the selected period, used in the sheet, toasts, and messaging.
  const periodLabel = rangeMode === 'single'
    ? selectedDate
    : (rangeBounds.from === rangeBounds.to ? rangeBounds.from : `${rangeBounds.from} to ${rangeBounds.to}`);

  // Filename-safe slug for the selected period.
  const periodSlug = rangeMode === 'single'
    ? selectedDate
    : (rangeBounds.from === rangeBounds.to ? rangeBounds.from : `${rangeBounds.from}_to_${rangeBounds.to}`);

  // Builds one validator's activity across the selected date (or date range) from the audit log.
  const buildActivityForValidator = (validatorName: string) => {
    const targetLower = validatorName.trim().toLowerCase();
    const dayLogs = logs.filter(l => {
      if (!l.rawTimestamp || !isDateInRange(toLocalDateKey(new Date(l.rawTimestamp)))) return false;
      const userLower = (l.user || '').trim().toLowerCase();
      if (!userLower) return false;
      return userLower === targetLower || targetLower.includes(userLower) || userLower.includes(targetLower);
    });

    const perQuestion = new Map<string, QuestionActivity>();
    let commentsAdded = 0;

    dayLogs.forEach(log => {
      const qid = log.questionId;
      if (!qid) return;
      if (!perQuestion.has(qid)) {
        perQuestion.set(qid, { questionId: qid, tags: new Set(), lastActionAt: log.timestamp });
      }
      const entry = perQuestion.get(qid)!;

      const d = stripBatchPrefix(log.description);
      if (isClaim(d)) entry.tags.add('Claimed');
      else if (isRelease(d)) entry.tags.add('Released Claim');
      else if (isFinalApprove(d)) entry.tags.add('Approved');
      else if (isFinalReject(d)) entry.tags.add('Rejected');
      else if (isNeedsRevision(d)) entry.tags.add('Needs Revision');
      else if (isComment(d)) {
        entry.tags.add('Commented');
        commentsAdded += 1;
      } else {
        entry.tags.add('Edited');
      }
    });

    const claimed = [...perQuestion.values()].filter(a => a.tags.has('Claimed')).length;
    const approved = [...perQuestion.values()].filter(a => a.tags.has('Approved')).length;
    const rejected = [...perQuestion.values()].filter(a => a.tags.has('Rejected')).length;
    const needsRevision = [...perQuestion.values()].filter(a => a.tags.has('Needs Revision')).length;

    return {
      validatorName,
      dayLogs,
      perQuestion,
      totals: {
        totalActions: dayLogs.length,
        claimed,
        approved,
        rejected,
        needsRevision,
        commentsAdded
      }
    };
  };

  const buildDetailRows = (activity: ReturnType<typeof buildActivityForValidator>) => {
    return [...activity.perQuestion.values()].map(entry => {
      const q = questionById.get(entry.questionId);
      const b2 = !q ? batch2ById.get(entry.questionId) : undefined;
      const commentsSource = q?.comments || b2?.comments || [];
      const ownComments = commentsSource.filter(c => c.author === activity.validatorName);
      const row: Record<string, string> = {
        'Question ID': entry.questionId,
        Subject: q?.Section || q?.section || q?.module || b2?.section || b2?.module || '',
        Domain: q?.category || b2?.category || '',
        'Sub Skill': q?.subSkill || b2?.subSkill || '',
        Difficulty: q?.difficulty || b2?.difficulty || '',
        'Action(s)': [...entry.tags].join(', '),
        'Current Review Status': q?.reviewStatus || b2?.reviewStatus || 'pending',
        'Comments (by this validator)': ownComments.map(c => `[${new Date(c.timestamp).toLocaleString()}] ${c.text}`).join(' | '),
        'Last Action Time': entry.lastActionAt,
        Source: q ? 'Curator' : (b2 ? 'New Batch' : 'Unknown (deleted?)')
      };
      // Only worth a dedicated day column when spanning more than one day —
      // for a single-day export the period is already implied by the sheet.
      if (rangeMode === 'range' && rangeBounds.from !== rangeBounds.to) {
        row['Date'] = toLocalDateKey(new Date(entry.lastActionAt));
      }
      return row;
    });
  };

  const detailColWidths = rangeMode === 'range' && rangeBounds.from !== rangeBounds.to
    ? [
      { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 10 },
      { wch: 22 }, { wch: 16 }, { wch: 50 }, { wch: 20 }, { wch: 12 }, { wch: 12 }
    ]
    : [
      { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 10 },
      { wch: 22 }, { wch: 16 }, { wch: 50 }, { wch: 20 }, { wch: 12 }
    ];

  const handleExport = () => {
    if (questions.length === 0 && logs.length === 0) {
      showToast('No activity data available to export yet.', 'error');
      return;
    }

    const workbook = XLSX.utils.book_new();

    if (selectedValidator === 'all') {
      // Every distinct validator name that actually has activity in this period —
      // not just current `validators`, so past/removed validators still show up.
      const namesWithActivity = Array.from(
        new Set(
          logs
            .filter(l => l.user && l.rawTimestamp && isDateInRange(toLocalDateKey(new Date(l.rawTimestamp))))
            .map(l => l.user as string)
        )
      ).sort();

      if (namesWithActivity.length === 0) {
        showToast(`No validator activity found for ${periodLabel}.`, 'error');
        return;
      }

      const summaryRows = namesWithActivity.map(name => {
        const activity = buildActivityForValidator(name);
        return {
          Validator: name,
          Period: periodLabel,
          'Questions Claimed': activity.totals.claimed,
          Approved: activity.totals.approved,
          Rejected: activity.totals.rejected,
          'Needs Revision': activity.totals.needsRevision,
          'Comments Added': activity.totals.commentsAdded,
          'Total Actions': activity.totals.totalActions
        };
      });

      const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
      summarySheet['!cols'] = [
        { wch: 22 }, { wch: 22 }, { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 12 }
      ];
      XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

      const usedNames = new Set<string>();
      namesWithActivity.forEach(name => {
        const activity = buildActivityForValidator(name);
        const rows = buildDetailRows(activity);
        const detailSheet = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ 'No activity': 'No questions touched in this period' }]);
        detailSheet['!cols'] = rows.length > 0 ? detailColWidths : undefined;
        let sheetName = sanitizeSheetName(name);
        // Excel sheet names must be unique — disambiguate collisions after truncation
        let suffix = 2;
        while (usedNames.has(sheetName)) {
          sheetName = `${sanitizeSheetName(name).slice(0, 28)} (${suffix})`;
          suffix += 1;
        }
        usedNames.add(sheetName);
        XLSX.utils.book_append_sheet(workbook, detailSheet, sheetName);
      });

      XLSX.writeFile(workbook, `validator-progress-all-${periodSlug}.xlsx`);
      showToast(`Exported progress for ${namesWithActivity.length} validator(s) — ${periodLabel}.`, 'success');
    } else {
      const profile = validators.find(v => v.id === selectedValidator);
      const validatorName = profile?.name || selectedValidator;
      const activity = buildActivityForValidator(validatorName);

      if (activity.totals.totalActions === 0) {
        showToast(`No activity found for ${validatorName} — ${periodLabel}.`, 'error');
        return;
      }

      const summarySheet = XLSX.utils.json_to_sheet([{
        Validator: validatorName,
        Period: periodLabel,
        'Questions Claimed': activity.totals.claimed,
        Approved: activity.totals.approved,
        Rejected: activity.totals.rejected,
        'Needs Revision': activity.totals.needsRevision,
        'Comments Added': activity.totals.commentsAdded,
        'Total Actions': activity.totals.totalActions
      }]);
      summarySheet['!cols'] = [
        { wch: 22 }, { wch: 22 }, { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 12 }
      ];
      XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

      const rows = buildDetailRows(activity);
      const detailSheet = XLSX.utils.json_to_sheet(rows);
      detailSheet['!cols'] = detailColWidths;
      XLSX.utils.book_append_sheet(workbook, detailSheet, 'Question Details');

      const slug = validatorName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'validator';
      XLSX.writeFile(workbook, `validator-progress-${slug}-${periodSlug}.xlsx`);
      showToast(`Exported progress for ${validatorName} — ${periodLabel}.`, 'success');
    }

    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true">
      <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        <div className="fixed inset-0 bg-zinc-900/40 transition-opacity" onClick={onClose} />
        <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

        <div className="relative z-10 inline-block align-bottom bg-white rounded-2xl text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full border border-[#e4e4e7]">
          <div className="px-5 py-4 border-b border-[#e4e4e7] flex items-center justify-between bg-[#fafafa]">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="w-4.5 h-4.5 text-green-700" />
              <h3 className="text-sm font-bold text-zinc-900">Export Validator Progress</h3>
            </div>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900 cursor-pointer">
              <X className="w-4.5 h-4.5" />
            </button>
          </div>

          <div className="px-5 py-5 space-y-4">
            <p className="text-xs text-zinc-500 leading-relaxed">
              Generates an Excel report of a validator's activity — questions claimed, approved, rejected, and
              marked needs revision, plus their comments and each question's subject, domain, and difficulty.
              Pick a single day, or a date range to cover several days in one export.
            </p>

            <div>
              <label className="flex items-center gap-1.5 text-xs font-bold text-zinc-600 mb-1.5">
                <UserIcon className="w-3.5 h-3.5" /> Validator
              </label>
              <select
                value={selectedValidator}
                onChange={(e) => setSelectedValidator(e.target.value)}
                className="w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] cursor-pointer"
              >
                <option value="all">All Validators (separate sheet per validator)</option>
                {validators.map(v => (
                  <option key={v.id} value={v.id}>{v.name} ({v.role})</option>
                ))}
              </select>
            </div>

            <div>
              <label className="flex items-center gap-1.5 text-xs font-bold text-zinc-600 mb-1.5">
                <CalendarRange className="w-3.5 h-3.5" /> Export Range
              </label>
              <div className="flex rounded-lg border border-[#e4e4e7] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setRangeMode('single')}
                  className={`flex-1 px-3 py-1.5 text-xs font-bold transition-all cursor-pointer ${rangeMode === 'single' ? 'bg-[#6366f1] text-white' : 'bg-white text-zinc-500 hover:bg-[#f2f2f3]'
                    }`}
                >
                  Single Day
                </button>
                <button
                  type="button"
                  onClick={() => setRangeMode('range')}
                  className={`flex-1 px-3 py-1.5 text-xs font-bold transition-all cursor-pointer border-l border-[#e4e4e7] ${rangeMode === 'range' ? 'bg-[#6366f1] text-white' : 'bg-white text-zinc-500 hover:bg-[#f2f2f3]'
                    }`}
                >
                  Date Range
                </button>
              </div>
            </div>

            {rangeMode === 'single' ? (
              <div>
                <label className="flex items-center gap-1.5 text-xs font-bold text-zinc-600 mb-1.5">
                  <CalendarDays className="w-3.5 h-3.5" /> Date
                </label>
                <input
                  type="date"
                  value={selectedDate}
                  max={todayKey()}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-bold text-zinc-600 mb-1.5">
                    <CalendarDays className="w-3.5 h-3.5" /> From
                  </label>
                  <input
                    type="date"
                    value={rangeStart}
                    max={todayKey()}
                    onChange={(e) => setRangeStart(e.target.value)}
                    className="w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                  />
                </div>
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-bold text-zinc-600 mb-1.5">
                    <CalendarDays className="w-3.5 h-3.5" /> To
                  </label>
                  <input
                    type="date"
                    value={rangeEnd}
                    max={todayKey()}
                    onChange={(e) => setRangeEnd(e.target.value)}
                    className="w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="px-5 py-4 border-t border-[#e4e4e7] bg-[#fafafa] flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-bold text-zinc-600 border border-[#e4e4e7] rounded-lg hover:bg-[#f2f2f3] transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white bg-green-700 hover:bg-green-600 rounded-lg border border-green-700 shadow-xs transition-all cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" /> Generate & Download
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}