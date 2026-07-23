import React, { useState, useEffect } from 'react';
import { X, Save, AlertCircle } from 'lucide-react';
import { SATQuestion } from '../types';

interface EditModalProps {
  question: SATQuestion | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (updatedQuestion: SATQuestion) => void;
}

export default function EditModal({ question, isOpen, onClose, onSave }: EditModalProps) {
  const [formData, setFormData] = useState<SATQuestion | null>(null);

  // Load question details whenever the modal is opened
  useEffect(() => {
    if (question) {
      setFormData({ ...question });
    } else {
      setFormData(null);
    }
  }, [question, isOpen]);

  if (!isOpen || !formData) return null;

  const handleTextChange = (field: keyof SATQuestion, value: string | null) => {
    setFormData((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        [field]: value
      };
    });
  };

  const handleChoiceChange = (choiceKey: 'A' | 'B' | 'C' | 'D', value: string) => {
    setFormData((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        choices: {
          ...prev.choices,
          [choiceKey]: value
        }
      };
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formData) {
      onSave(formData);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="modal-title" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        <div 
          className="fixed inset-0 bg-black/90 transition-opacity" 
          aria-hidden="true"
          onClick={onClose}
        />

        {/* Center alignment trick */}
        <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

        {/* Modal content body */}
        <div className="relative z-[60] inline-block align-bottom bg-[#fafafa] rounded-xl text-left overflow-hidden shadow-2xl transform transition-all sm:my-8 sm:align-middle sm:max-w-2xl sm:w-full border border-[#e4e4e7]">
          {/* Header */}
          <div className="flex justify-between items-center px-6 py-4 border-b border-[#e4e4e7] bg-[#f2f2f3]">
            <div className="flex flex-col">
              <h3 className="text-base font-bold text-zinc-900" id="modal-title">
                Edit Test Item
              </h3>
              <p className="text-xs text-zinc-500 font-mono mt-0.5">{formData.id}</p>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-900 hover:bg-[#e4e4e7] transition-all cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="px-6 py-5 max-h-[70vh] overflow-y-auto space-y-4">
              
              {/* Metadata Row */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-zinc-500">Section</label>
                  <select
                    value={formData.Section || formData.section || 'Reading_Writing'}
                    onChange={(e) => {
                      const val = e.target.value;
                      setFormData(prev => prev ? { ...prev, Section: val, section: val } : null);
                    }}
                    className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                  >
                    <option value="Reading_Writing" className="bg-white">Reading &amp; Writing</option>
                    <option value="Math" className="bg-white">Mathematics</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-zinc-500">Difficulty</label>
                  <select
                    value={formData.difficulty}
                    onChange={(e) => handleTextChange('difficulty', e.target.value)}
                    className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                  >
                    <option value="easy" className="bg-white">Easy</option>
                    <option value="medium" className="bg-white">Medium</option>
                    <option value="hard" className="bg-white">Hard</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-zinc-500">Domain Category</label>
                  <input
                    type="text"
                    required
                    value={formData.category}
                    onChange={(e) => handleTextChange('category', e.target.value)}
                    className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                    placeholder="e.g., Algebra"
                  />
                </div>
              </div>

              {/* Question type + sub-skill + supporting graphic (spec §4) */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-zinc-500">Question Type</label>
                  <select
                    value={formData.questionType || 'mcq'}
                    onChange={(e) => handleTextChange('questionType', e.target.value)}
                    className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                  >
                    <option value="mcq" className="bg-white">MCQ</option>
                    <option value="grid_in" className="bg-white">Grid-In</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-zinc-500">Sub-Skill</label>
                  <input
                    type="text"
                    value={formData.subSkill || ''}
                    onChange={(e) => handleTextChange('subSkill', e.target.value || null)}
                    className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                    placeholder="e.g., Linear equations"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-zinc-500">Supporting Graphic URL</label>
                  <input
                    type="text"
                    value={formData.imageUrl || ''}
                    onChange={(e) => handleTextChange('imageUrl', e.target.value || null)}
                    className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                    placeholder="https://... (optional)"
                  />
                </div>
              </div>

              {/* Passage (optional) */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-zinc-500 flex items-center justify-between">
                  <span>Passage Text (Optional)</span>
                  <span className="text-[11px] font-normal text-zinc-500">Mainly for English / Reading comprehension items</span>
                </label>
                <textarea
                  value={formData.passage || ''}
                  onChange={(e) => handleTextChange('passage', e.target.value || null)}
                  className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] min-h-[90px] font-sans"
                  placeholder="Enter context, background passage, or text prompt here..."
                />
              </div>

              {/* Stimulus (optional) — kept separate from Passage. Holds equations,
                  systems of equations, data tables, or graph descriptions, esp.
                  common on Math items. Monospace + whitespace-preserving so
                  multi-line equations don't get collapsed. */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-zinc-500 flex items-center justify-between">
                  <span>Stimulus (Optional)</span>
                  <span className="text-[11px] font-normal text-zinc-500">Equations, systems, data/tables — common on Math items</span>
                </label>
                <textarea
                  value={formData.stimulus || ''}
                  onChange={(e) => handleTextChange('stimulus', e.target.value || null)}
                  className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] min-h-[70px] font-mono whitespace-pre-wrap"
                  placeholder="e.g., Equation: 4x - 7 = 3x + 9"
                />
              </div>

              {/* Question */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-zinc-500">Question Statement</label>
                <textarea
                  required
                  value={formData.question}
                  onChange={(e) => handleTextChange('question', e.target.value)}
                  className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] min-h-[60px] font-sans font-medium"
                  placeholder="Which choice completes the text with the most logical..."
                />
              </div>

              {/* Multiple Choices */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-2">
                {(['A', 'B', 'C', 'D'] as const).map((key) => (
                  <div key={key} className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-zinc-500 flex items-center gap-1.5">
                      <span className="w-5 h-5 rounded-md bg-[#f2f2f3] text-zinc-600 flex items-center justify-center text-[11px] font-bold border border-[#e4e4e7]">
                        {key}
                      </span>
                      <span>Option {key}</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={formData.choices[key]}
                      onChange={(e) => handleChoiceChange(key, e.target.value)}
                      className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                    />
                  </div>
                ))}
              </div>

              {/* Answer Keys */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 pt-2">
                <div className="flex flex-col gap-1.5 sm:col-span-1">
                  <label className="text-xs font-bold text-zinc-500">Correct Answer</label>
                  <select
                    value={formData.correct_answer}
                    onChange={(e) => handleTextChange('correct_answer', e.target.value)}
                    className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500 text-emerald-600 font-bold"
                  >
                    <option value="A" className="bg-white">A</option>
                    <option value="B" className="bg-white">B</option>
                    <option value="C" className="bg-white">C</option>
                    <option value="D" className="bg-white">D</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5 sm:col-span-2 bg-[#f2f2f3] border border-[#e4e4e7] rounded-xl p-2 text-[12px] text-zinc-500 leading-normal flex-row items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-zinc-500 shrink-0" />
                  <span>
                    Ensure that the correct answer corresponds exactly to the option letter selected on the left.
                  </span>
                </div>
              </div>

              {/* Explanation Text */}
              <div className="flex flex-col gap-1.5 pt-1">
                <label className="text-xs font-bold text-zinc-500">Key Explanation Details</label>
                <textarea
                  required
                  value={formData.explanation}
                  onChange={(e) => handleTextChange('explanation', e.target.value)}
                  className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-900 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] min-h-[90px] font-sans"
                  placeholder="Explain why this option is correct and why other choices are wrong..."
                />
              </div>

            </div>

            {/* Actions footer */}
            <div className="px-6 py-4 border-t border-[#e4e4e7] bg-[#f2f2f3] flex justify-end gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-[#e4e4e7] text-zinc-500 hover:text-zinc-900 hover:bg-[#e4e4e7] text-sm font-semibold rounded-lg transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex items-center gap-1.5 px-4.5 py-2 bg-[#6366f1] text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 transition-all cursor-pointer"
              >
                <Save className="w-4 h-4" />
                Save Changes
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
