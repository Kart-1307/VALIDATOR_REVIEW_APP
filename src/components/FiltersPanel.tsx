import { Search, RotateCcw, HelpCircle } from 'lucide-react';
import { FilterState } from '../types';

interface FiltersPanelProps {
  filters: FilterState;
  onChangeFilters: (newFilters: Partial<FilterState>) => void;
  categories: string[];
  sections: string[];
  onResetAll: () => void;
  hasActiveFilters: boolean;
  validators?: { id: string; name: string; email: string }[];
}

export default function FiltersPanel({
  filters,
  onChangeFilters,
  categories,
  sections,
  onResetAll,
  hasActiveFilters,
  validators = []
}: FiltersPanelProps) {
  
  const formatLabel = (val: string) => {
    if (!val) return 'All';
    return val.replace(/_/g, ' & ');
  };

  return (
    <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-5 mb-6 shadow-sm">
      <div className="flex flex-col gap-4">
        {/* Search and Quick Filters header */}
        <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center">
          <div className="relative flex-1">
            <span className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
              <Search className="h-4.5 w-4.5 text-zinc-500" />
            </span>
            <input
              type="text"
              placeholder="Search by question keyword, passage, explanation or id..."
              value={filters.search}
              onChange={(e) => onChangeFilters({ search: e.target.value })}
              className="block w-full pl-10 pr-4 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] transition-all placeholder:text-zinc-500"
            />
          </div>

          {hasActiveFilters && (
            <button
              onClick={onResetAll}
              className="flex items-center justify-center gap-2 px-3.5 py-2 border border-[#e4e4e7] text-zinc-500 hover:text-zinc-900 hover:bg-[#f2f2f3] text-sm font-medium rounded-lg transition-all cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Filters
            </button>
          )}
        </div>

        {/* Dropdowns row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Section Selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-zinc-500">Test Section</label>
            <select
              value={filters.section}
              onChange={(e) => onChangeFilters({ section: e.target.value, category: '' })} // reset category on section switch
              className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] transition-all"
            >
              <option value="" className="bg-white">All Sections</option>
              {sections.map((sect) => (
                <option key={sect} value={sect} className="bg-white">
                  {formatLabel(sect)}
                </option>
              ))}
            </select>
          </div>

          {/* Domain Category Selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-zinc-500">Skill Domain</label>
            <select
              value={filters.category}
              onChange={(e) => onChangeFilters({ category: e.target.value })}
              className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] transition-all"
            >
              <option value="" className="bg-white">All Domains</option>
              {categories.map((cat) => (
                <option key={cat} value={cat} className="bg-white">
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {/* Difficulty Level Selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-zinc-500">Difficulty Level</label>
            <select
              value={filters.difficulty}
              onChange={(e) => onChangeFilters({ difficulty: e.target.value })}
              className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] transition-all"
            >
              <option value="" className="bg-white">All Difficulties</option>
              <option value="easy" className="bg-white">Easy</option>
              <option value="medium" className="bg-white">Medium</option>
              <option value="hard" className="bg-white">Hard</option>
            </select>
          </div>
        </div>

        {/* spec §3: generator run id, assigned/claimed validator, date generated */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-zinc-500">Generator Run ID</label>
            <input
              type="text"
              placeholder="e.g. run-2026-07-01"
              value={filters.generatorRunId || ''}
              onChange={(e) => onChangeFilters({ generatorRunId: e.target.value })}
              className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] transition-all placeholder:text-zinc-600"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-zinc-500">Assigned / Claimed By</label>
            <select
              value={filters.assignedOrClaimedBy || ''}
              onChange={(e) => onChangeFilters({ assignedOrClaimedBy: e.target.value })}
              className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] transition-all"
            >
              <option value="" className="bg-white">Anyone</option>
              {validators.map(v => (
                <option key={v.id} value={v.id} className="bg-white">{v.name || v.email}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-zinc-500">Generated From</label>
            <input
              type="date"
              value={filters.dateFrom || ''}
              onChange={(e) => onChangeFilters({ dateFrom: e.target.value })}
              className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] transition-all"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-zinc-500">Generated To</label>
            <input
              type="date"
              value={filters.dateTo || ''}
              onChange={(e) => onChangeFilters({ dateTo: e.target.value })}
              className="block w-full px-3 py-2 border border-[#e4e4e7] rounded-lg text-sm bg-white text-zinc-700 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] transition-all"
            />
          </div>
        </div>

        {/* Informative Help Note */}
        <div className="flex items-start gap-2 text-xs text-zinc-500 bg-[#f2f2f3] border border-[#e4e4e7] rounded-lg p-2.5">
          <HelpCircle className="w-3.5 h-3.5 mt-0.5 text-indigo-600 shrink-0" />
          <span>
            <strong>Pro-tip:</strong> Clicking on status cards above directly filters questions by their <strong>Approved</strong>, <strong>Rejected</strong>, or <strong>Pending Review</strong> status.
          </span>
        </div>
      </div>
    </div>
  );
}
