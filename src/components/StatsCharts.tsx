import { StatsSummary } from '../types';
import { Layers, Flame, BookOpen } from 'lucide-react';

interface StatsChartsProps {
  stats: StatsSummary;
}

export default function StatsCharts({ stats }: StatsChartsProps) {
  // Helper to calculate percentages safely
  const getPercent = (count: number) => {
    if (!stats.total) return 0;
    return Math.round((count / stats.total) * 100);
  };

  // 1. Difficulty Tier counts
  const easyCount = stats.byDifficulty['easy'] || 0;
  const mediumCount = stats.byDifficulty['medium'] || 0;
  const hardCount = stats.byDifficulty['hard'] || 0;

  // 2. Section balances
  const readingCount = stats.bySection['Reading_Writing'] || stats.bySection['reading_writing'] || 0;
  const mathCount = stats.bySection['Math'] || stats.bySection['math'] || 0;

  // 3. Top categories/domains
  const topCategories = Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-6">
      
      {/* Chart Card 1: Section Balance */}
      <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-5 shadow-sm flex flex-col justify-between">
        <div>
          <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3.5 flex items-center gap-1.5">
            <BookOpen className="w-3.5 h-3.5 text-zinc-500" /> Section Balance
          </h4>
          
          <div className="space-y-4">
            <div className="flex justify-between items-center text-xs">
              <span className="font-semibold text-zinc-600">Reading &amp; Writing</span>
              <span className="font-mono text-zinc-500 font-bold">{readingCount} questions ({getPercent(readingCount)}%)</span>
            </div>
            
            <div className="flex justify-between items-center text-xs">
              <span className="font-semibold text-zinc-600">Mathematics</span>
              <span className="font-mono text-zinc-500 font-bold">{mathCount} questions ({getPercent(mathCount)}%)</span>
            </div>
          </div>
        </div>

        {/* Visual progress track */}
        <div className="mt-5">
          <div className="w-full h-3.5 bg-[#f2f2f3] rounded-full overflow-hidden flex">
            <div 
              style={{ width: `${getPercent(readingCount)}%` }} 
              className="h-full bg-[#6366f1] transition-all duration-500" 
              title={`Reading & Writing: ${getPercent(readingCount)}%`}
            />
            <div 
              style={{ width: `${getPercent(mathCount)}%` }} 
              className="h-full bg-amber-500 transition-all duration-500" 
              title={`Mathematics: ${getPercent(mathCount)}%`}
            />
          </div>
          <div className="flex justify-between items-center mt-2 text-[11px] text-zinc-500 font-medium">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#6366f1]" /> Reading/Writing</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Mathematics</span>
          </div>
        </div>
      </div>

      {/* Chart Card 2: Difficulty Tiers */}
      <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-5 shadow-sm">
        <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-4 flex items-center gap-1.5">
          <Flame className="w-3.5 h-3.5 text-zinc-500" /> Difficulty Distribution
        </h4>

        <div className="space-y-3.5">
          {/* Easy Progress bar */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-semibold text-zinc-600">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> Easy</span>
              <span className="font-mono text-zinc-500 font-normal">{easyCount} items ({getPercent(easyCount)}%)</span>
            </div>
            <div className="w-full h-2 bg-[#f2f2f3] rounded-full overflow-hidden">
              <div 
                style={{ width: `${getPercent(easyCount)}%` }} 
                className="h-full bg-blue-500 rounded-full transition-all duration-500"
              />
            </div>
          </div>

          {/* Medium Progress bar */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-semibold text-zinc-600">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Medium</span>
              <span className="font-mono text-zinc-500 font-normal">{mediumCount} items ({getPercent(mediumCount)}%)</span>
            </div>
            <div className="w-full h-2 bg-[#f2f2f3] rounded-full overflow-hidden">
              <div 
                style={{ width: `${getPercent(mediumCount)}%` }} 
                className="h-full bg-amber-500 rounded-full transition-all duration-500"
              />
            </div>
          </div>

          {/* Hard Progress bar */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-semibold text-zinc-600">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500" /> Hard</span>
              <span className="font-mono text-zinc-500 font-normal">{hardCount} items ({getPercent(hardCount)}%)</span>
            </div>
            <div className="w-full h-2 bg-[#f2f2f3] rounded-full overflow-hidden">
              <div 
                style={{ width: `${getPercent(hardCount)}%` }} 
                className="h-full bg-rose-500 rounded-full transition-all duration-500"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Chart Card 3: Top Domain Categories */}
      <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-5 shadow-sm">
        <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-4 flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-zinc-500" /> Top Skill Domains
        </h4>

        {topCategories.length === 0 ? (
          <p className="text-xs text-zinc-500 italic text-center py-6">No category data available</p>
        ) : (
          <div className="space-y-2.5">
            {topCategories.map(([cat, count], idx) => (
              <div key={cat} className="space-y-1">
                <div className="flex justify-between text-xs text-zinc-600 font-medium">
                  <span className="truncate max-w-[170px]" title={cat}>{cat}</span>
                  <span className="font-mono text-zinc-500 shrink-0">{count} questions</span>
                </div>
                <div className="w-full h-1 bg-[#f2f2f3] rounded-full overflow-hidden">
                  <div 
                    style={{ width: `${getPercent(count)}%` }} 
                    className="h-full bg-[#6366f1] rounded-full transition-all duration-500"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
