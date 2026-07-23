import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Copy, AlertCircle, HelpCircle } from 'lucide-react';
import { SATQuestion } from '../types';

interface DuplicateCompareModalProps {
  isOpen: boolean;
  flaggedQuestion: SATQuestion | null;
  matchedQuestion: SATQuestion | null | undefined;
  onClose: () => void;
}

// Small reusable read-only rendering of a single question, used twice below
// (once for the flagged item, once for the item it was matched against) so
// a reviewer can eyeball both at the same time instead of just a score.
function QuestionPreviewPane({
  label,
  question,
  accent
}: {
  label: string;
  question: SATQuestion | null | undefined;
  accent: 'indigo' | 'zinc';
}) {
  if (!question) {
    return (
      <div className="flex-1 min-w-0 rounded-xl border border-[#e4e4e7] bg-white p-5 flex flex-col items-center justify-center text-center gap-2">
        <AlertCircle className="w-5 h-5 text-zinc-600" />
        <p className="text-xs text-zinc-500 leading-relaxed">
          The matched question <span className="font-mono">id</span> referenced by{' '}
          <span className="font-mono">similar_question_id</span> could not be found in the
          currently loaded workspace. It may belong to a different (unmerged) export file.
        </p>
      </div>
    );
  }

  const accentBorder = accent === 'indigo' ? 'border-indigo-500/40' : 'border-[#e4e4e7]';
  const accentBadge =
    accent === 'indigo'
      ? 'bg-indigo-50 text-[#4f46e5] border-indigo-200'
      : 'bg-[#ececed] text-zinc-600 border-[#e4e4e7]';

  return (
    <div className={`flex-1 min-w-0 rounded-xl border ${accentBorder} bg-white flex flex-col overflow-hidden`}>
      <div className="px-4 py-3 border-b border-[#e4e4e7] bg-[#fafafa] flex items-center justify-between gap-2">
        <span className={`text-[12px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-md border ${accentBadge}`}>
          {label}
        </span>
        <span className="font-mono text-[12px] text-zinc-500 select-all truncate">{question.id}</span>
      </div>

      <div className="p-4 space-y-3 overflow-y-auto max-h-[55vh]">
        {question.passage && (
          <div className="bg-[#f2f2f3] border-l-4 border-indigo-500 pl-3 py-2.5 pr-2 text-xs text-zinc-600 italic leading-relaxed rounded-r-lg">
            {question.passage}
          </div>
        )}

        {question.stimulus && (
          <div className="bg-[#f2f2f3] border-l-4 border-amber-500 pl-3 py-2.5 pr-2 text-xs text-zinc-700 leading-relaxed font-mono whitespace-pre-wrap rounded-r-lg">
            {question.stimulus}
          </div>
        )}

        <p className="text-sm font-semibold text-zinc-900 leading-relaxed">{question.question}</p>

        <div className="grid grid-cols-1 gap-2">
          {Object.entries(question.choices).map(([key, value]) => {
            const isCorrect = key === question.correct_answer;
            return (
              <div
                key={key}
                className={`flex items-start gap-2 p-2.5 rounded-lg border text-xs leading-normal ${
                  isCorrect
                    ? 'border-emerald-500 bg-[rgba(16,185,129,0.05)] text-emerald-600 font-medium'
                    : 'border-[#e4e4e7] bg-[#f2f2f3] text-zinc-600'
                }`}
              >
                <span
                  className={`w-4.5 h-4.5 rounded-md flex items-center justify-center text-[11px] font-bold border shrink-0 ${
                    isCorrect ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-[#e4e4e7] text-zinc-500 border-[#d4d4d8]'
                  }`}
                >
                  {key}
                </span>
                <span>{value}</span>
              </div>
            );
          })}
        </div>

        <div className="rounded-lg border border-[#e4e4e7] bg-[#fafafa] p-3 text-xs text-zinc-500 leading-relaxed">
          <p className="font-medium text-zinc-900 mb-1 flex items-center gap-1">
            <HelpCircle className="w-3.5 h-3.5 text-emerald-600" /> Explanation:
          </p>
          {question.explanation}
        </div>

        <div className="flex flex-wrap gap-1.5 pt-1">
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#ececed] text-zinc-500 border border-[#e4e4e7]">
            {question.category}
          </span>
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#ececed] text-zinc-500 border border-[#e4e4e7]">
            {(question.difficulty || 'medium').toUpperCase()}
          </span>
          {question.reviewStatus && (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#ececed] text-zinc-500 border border-[#e4e4e7] capitalize">
              {question.reviewStatus}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DuplicateCompareModal({
  isOpen,
  flaggedQuestion,
  matchedQuestion,
  onClose
}: DuplicateCompareModalProps) {
  return (
    <AnimatePresence>
      {isOpen && flaggedQuestion && (
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
            className="relative w-full max-w-5xl bg-[#fafafa] border border-[#e4e4e7] rounded-2xl shadow-2xl overflow-hidden z-10"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3]">
              <div className="flex items-center gap-2">
                <Copy className="w-4 h-4 text-amber-700" />
                <div>
                  <h3 className="text-sm font-bold text-zinc-900 tracking-tight">Near-Duplicate Comparison</h3>
                  <p className="text-[12px] text-zinc-500">
                    {typeof flaggedQuestion.similarity_score === 'number'
                      ? `Flagged as ${Math.round(flaggedQuestion.similarity_score * 100)}% similar`
                      : 'Flagged possible duplicate'}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-[#e4e4e7] rounded-lg transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 flex flex-col md:flex-row gap-4">
              <QuestionPreviewPane label="Flagged Question" question={flaggedQuestion} accent="indigo" />
              <QuestionPreviewPane label="Matched Against" question={matchedQuestion} accent="zinc" />
            </div>

            <div className="px-5 pb-5">
              <p className="text-[12px] text-zinc-500 leading-relaxed">
                Compare the wording, choices, and correct answer above to decide whether this is a genuine
                duplicate worth rejecting, or simply a similarly-themed item that should stay in the bank.
              </p>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
