import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  History, 
  Search, 
  Trash2, 
  Download, 
  CheckCircle, 
  XCircle, 
  RefreshCw, 
  Edit3, 
  UploadCloud, 
  Info,
  MessageSquare,
  Calendar,
  User,
  Clock,
  Filter
} from 'lucide-react';

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  rawTimestamp?: string; // ISO string, used for date-bucketed analytics
  action: 'approve' | 'reject' | 'reset' | 'edit' | 'upload' | 'clear' | 'note';
  questionId?: string;
  description: string;
  user?: string;
}

interface AuditActivityLogsProps {
  logs: AuditLogEntry[];
  onClearLogs: () => void;
}

export default function AuditActivityLogs({ logs, onClearLogs }: AuditActivityLogsProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [actionFilter, setActionFilter] = useState<string>('all');

  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      const matchSearch = searchQuery === '' || 
        log.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (log.questionId && log.questionId.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (log.user && log.user.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchAction = actionFilter === 'all' || log.action === actionFilter;

      return matchSearch && matchAction;
    });
  }, [logs, searchQuery, actionFilter]);

  const getActionStyles = (action: string) => {
    switch (action) {
      case 'approve':
        return {
          icon: <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />,
          bgColor: 'bg-emerald-50 text-emerald-600 border-emerald-200',
          label: 'APPROVED'
        };
      case 'reject':
        return {
          icon: <XCircle className="w-3.5 h-3.5 text-rose-600" />,
          bgColor: 'bg-rose-50 text-rose-600 border-rose-200',
          label: 'REJECTED'
        };
      case 'reset':
        return {
          icon: <RefreshCw className="w-3.5 h-3.5 text-zinc-500" />,
          bgColor: 'bg-[#f2f2f3] text-zinc-500 border-[#e4e4e7]',
          label: 'RESET STATUS'
        };
      case 'edit':
        return {
          icon: <Edit3 className="w-3.5 h-3.5 text-amber-700" />,
          bgColor: 'bg-amber-50 text-amber-700 border-amber-200',
          label: 'EDIT ITEM'
        };
      case 'upload':
        return {
          icon: <UploadCloud className="w-3.5 h-3.5 text-indigo-600" />,
          bgColor: 'bg-indigo-50 text-[#4f46e5] border-indigo-200',
          label: 'IMPORT BANK'
        };
      case 'note':
        return {
          icon: <MessageSquare className="w-3.5 h-3.5 text-sky-600" />,
          bgColor: 'bg-sky-50 text-sky-600 border-sky-200',
          label: 'REVIEWER NOTE'
        };
      case 'clear':
        return {
          icon: <Trash2 className="w-3.5 h-3.5 text-rose-600" />,
          bgColor: 'bg-rose-50 text-rose-600 border-rose-200',
          label: 'WORKSPACE WIPE'
        };
      default:
        return {
          icon: <Info className="w-3.5 h-3.5 text-zinc-500" />,
          bgColor: 'bg-zinc-100 text-zinc-500 border-[#e4e4e7]',
          label: 'SYSTEM'
        };
    }
  };

  const handleDownloadLogJSON = () => {
    if (logs.length === 0) return;
    
    const jsonString = `data:text/json;charset=utf-8,${encodeURIComponent(
      JSON.stringify(logs, null, 2)
    )}`;
    
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', jsonString);
    downloadAnchor.setAttribute('download', `sat_curator_audit_log_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // --- Spec §8: Exportable audit report (CSV) for QA/compliance ---
  const handleDownloadLogCSV = () => {
    if (logs.length === 0) return;

    const escapeCsv = (val: string | undefined) => {
      const s = (val ?? '').replace(/"/g, '""');
      return `"${s}"`;
    };

    const header = ['Log ID', 'Timestamp', 'Action', 'Question ID', 'Validator', 'Description'];
    const rows = logs.map(log => [
      escapeCsv(log.id),
      escapeCsv(log.timestamp),
      escapeCsv(log.action),
      escapeCsv(log.questionId || ''),
      escapeCsv(log.user || ''),
      escapeCsv(log.description)
    ].join(','));

    const csvContent = `data:text/csv;charset=utf-8,${encodeURIComponent(
      [header.join(','), ...rows].join('\n')
    )}`;

    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', csvContent);
    downloadAnchor.setAttribute('download', `sat_curator_audit_log_${Date.now()}.csv`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div className="space-y-5">
      
      {/* Search and control bar */}
      <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-4 flex flex-col md:flex-row gap-3.5 justify-between items-stretch md:items-center">
        
        {/* Search */}
        <div className="relative flex-1">
          <span className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
            <Search className="h-4.5 w-4.5 text-zinc-500" />
          </span>
          <input
            type="text"
            placeholder="Search activity description, question ID, or curator..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full pl-10 pr-4 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] transition-all placeholder:text-zinc-500"
          />
        </div>

        {/* Action filter category */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-zinc-500 font-semibold select-none pr-1">
            <Filter className="w-3.5 h-3.5 text-zinc-500" /> Action:
          </div>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="px-3 py-1.5 border border-[#e4e4e7] rounded-lg text-xs bg-white text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] cursor-pointer"
          >
            <option value="all">All Actions</option>
            <option value="approve">Approved</option>
            <option value="reject">Rejected</option>
            <option value="reset">Resets</option>
            <option value="edit">Edits</option>
            <option value="upload">Uploads</option>
            <option value="note">Reviewer Notes</option>
            <option value="clear">Workspace Clears</option>
          </select>

          {/* Action Button: Download */}
          <button
            onClick={handleDownloadLogJSON}
            disabled={logs.length === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
              logs.length === 0
                ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed'
                : 'bg-[#f2f2f3] hover:bg-[#e4e4e7] text-zinc-600 border-[#e4e4e7]'
            }`}
            title="Download full curator activity session log"
          >
            <Download className="w-3.5 h-3.5" /> Download Logs JSON
          </button>

          {/* Action Button: Download CSV (spec §8: exportable audit report for QA/compliance) */}
          <button
            onClick={handleDownloadLogCSV}
            disabled={logs.length === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
              logs.length === 0
                ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed'
                : 'bg-[#f2f2f3] hover:bg-[#e4e4e7] text-zinc-600 border-[#e4e4e7]'
            }`}
            title="Export audit trail as CSV for QA/compliance"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>

          {/* Action Button: Clear */}
          <button
            onClick={() => {
              if (window.confirm('Are you sure you want to clear your local session activity log?')) {
                onClearLogs();
              }
            }}
            disabled={logs.length === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
              logs.length === 0
                ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed'
                : 'bg-rose-50 text-rose-600 border-rose-200 hover:bg-rose-900/40'
            }`}
            title="Clear this browser's local session log (does not affect a backend audit record)"
          >
            <Trash2 className="w-3.5 h-3.5" /> Clear Local Session
          </button>
        </div>
      </div>

      {/* Main Activity Timeline list */}
      <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3] flex justify-between items-center select-none">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-indigo-600" />
            <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">Curation Audit Trail</h4>
          </div>
          <span className="font-mono text-[12px] font-bold text-zinc-500 bg-[#fafafa] border border-[#e4e4e7] px-2.5 py-0.5 rounded-full">
            Logged {filteredLogs.length} events
          </span>
        </div>
        <div className="px-5 py-2 border-b border-[#e4e4e7] bg-[#fcfcfc] text-[12px] text-zinc-500 leading-relaxed">
          This trail is written to the shared Supabase <code>audit_log</code> table on every action — append-only, immutable
          per spec §8. "Clear" below only clears your local view; the underlying record is untouched and reappears on refresh.
        </div>

        <div className="p-5 max-h-[500px] overflow-y-auto space-y-4">
          <AnimatePresence mode="popLayout">
            {filteredLogs.map((log) => {
              const styles = getActionStyles(log.action);
              return (
                <motion.div
                  key={log.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  transition={{ duration: 0.15 }}
                  className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-3 rounded-lg border border-[#e4e4e7] bg-[#fdfdfd] hover:border-[#d4d4d8] transition-all"
                >
                  <div className="flex items-start gap-3">
                    {/* Event action badge */}
                    <div className={`text-[11px] font-bold tracking-wider px-2 py-1 rounded-md border flex items-center gap-1 shrink-0 ${styles.bgColor}`}>
                      {styles.icon}
                      <span>{styles.label}</span>
                    </div>

                    <div className="space-y-1">
                      {/* Event description */}
                      <p className="text-xs text-zinc-600 font-semibold leading-relaxed">
                        {log.description}
                      </p>
                      
                      {/* Meta information row */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500 font-mono">
                        {log.questionId && (
                          <span className="text-indigo-600 bg-indigo-50 px-1.5 py-0.2 rounded border border-indigo-200">
                            ID: {log.questionId}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <User className="w-3 h-3 text-zinc-500" />
                          <span>{log.user || 'Curator'}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-zinc-500" />
                          <span>{log.timestamp}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}

            {filteredLogs.length === 0 && (
              <div className="text-center py-12 text-zinc-500 text-xs italic">
                {logs.length === 0 
                  ? 'No actions logged in this session yet. Actions will record automatically as you approve, reject, edit, or reset questions.'
                  : 'No log entries match your active search or action filters.'}
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>

    </div>
  );
}
