import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CalendarRange, ChevronDown, Download, FileText } from 'lucide-react';
import { toLocalDateKey } from '../lib/mappers';

interface ExportMenuProps {
  label: string;
  title?: string;
  disabled?: boolean;
  buttonClassName: string;
  confirmClassName: string;
  all: { label: string; hint: string; onExport: () => void | Promise<void> };
  range: {
    label: string;
    hint: string;
    heading: string;
    description: string;
    onExport: (fromKey: string, toKey: string) => void | Promise<void>;
  };
}

// Dropdown with two choices: export everything, or export a date range.
export default function ExportMenu({ label, title, disabled, buttonClassName, confirmClassName, all, range }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const todayKey = toLocalDateKey(new Date().toISOString()) || '';
  const [fromKey, setFromKey] = useState(todayKey);
  const [toKey, setToKey] = useState(todayKey);
  const [popupAbove, setPopupAbove] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const close = () => { setOpen(false); setRangeOpen(false); };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Open the range popup above the button when there is no room below it.
  useLayoutEffect(() => {
    if (!rangeOpen) return;
    const wrap = wrapRef.current;
    const popup = wrap?.querySelector('[data-range-popup]') as HTMLElement | null;
    if (!wrap || !popup) return;
    const rect = wrap.getBoundingClientRect();
    setPopupAbove(popup.offsetHeight > window.innerHeight - rect.bottom && popup.offsetHeight <= rect.top);
  }, [rangeOpen]);

  const run = async (fn: () => void | Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); close(); }
  };

  const itemClass = 'w-full flex items-center gap-2.5 px-3.5 py-3 text-left hover:bg-[#f2f2f3] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
  const inputClass = 'mt-1 w-full px-2 py-1.5 text-[11px] font-medium border border-[#e4e4e7] rounded-lg bg-white text-zinc-700';

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => { setOpen(o => !o); setRangeOpen(false); }}
        disabled={disabled}
        title={title}
        className={`inline-flex items-center justify-center gap-1.5 px-3.5 h-10 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
          disabled ? 'bg-[#fafafa] text-zinc-600 border-[#e4e4e7] cursor-not-allowed' : buttonClassName
        }`}
      >
        <Download className="w-4 h-4" />
        {label}
        <ChevronDown className={`w-4 h-4 transition-transform ${open && !rangeOpen ? 'rotate-180' : ''}`} />
      </button>

      {open && !rangeOpen && (
        <div className="absolute right-0 mt-1.5 w-64 max-w-[calc(100vw-1.5rem)] bg-white border border-[#e4e4e7] rounded-xl shadow-2xl z-30 overflow-hidden">
          <button onClick={() => run(all.onExport)} disabled={busy} className={itemClass}>
            <FileText className="w-4 h-4 text-zinc-500 shrink-0" />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-zinc-900">{all.label}</span>
              <span className="block text-[11px] text-zinc-500">{all.hint}</span>
            </span>
          </button>
          <div className="border-t border-[#e4e4e7]" />
          <button onClick={() => setRangeOpen(true)} className={itemClass}>
            <CalendarRange className="w-4 h-4 text-[#4f46e5] shrink-0" />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-zinc-900">{range.label}</span>
              <span className="block text-[11px] text-zinc-500">{range.hint}</span>
            </span>
          </button>
        </div>
      )}

      {open && rangeOpen && (
        <div
          data-range-popup
          className={`absolute right-0 w-72 max-w-[calc(100vw-1.5rem)] bg-white border border-[#e4e4e7] rounded-xl shadow-2xl z-30 overflow-hidden p-3.5 ${
            popupAbove ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          <p className="text-xs font-bold text-zinc-900">{range.heading}</p>
          <p className="text-[11px] text-zinc-500 mb-2">{range.description}</p>
          <div className="flex flex-col gap-2">
            <label className="text-[11px] font-semibold text-zinc-600">
              From
              <input type="date" value={fromKey} onChange={e => setFromKey(e.target.value)} className={inputClass} />
            </label>
            <label className="text-[11px] font-semibold text-zinc-600">
              To
              <input type="date" value={toKey} onChange={e => setToKey(e.target.value)} className={inputClass} />
            </label>
            <div className="mt-1 flex items-center justify-end gap-2">
              <button
                onClick={close}
                className="px-2.5 py-1.5 text-[11px] font-bold rounded-lg border border-[#e4e4e7] bg-[#fafafa] text-zinc-700 hover:bg-[#f2f2f3] transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => run(() => range.onExport(fromKey, toKey))}
                disabled={busy || !fromKey || !toKey}
                className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold rounded-lg border transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${confirmClassName}`}
              >
                <Download className="w-3 h-3" /> Export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
