import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  BarChart2, 
  BookOpen, 
  CheckCircle2, 
  XCircle, 
  HelpCircle, 
  Search, 
  ChevronRight, 
  Layers, 
  TrendingUp, 
  ArrowRight,
  Sparkles,
  PieChart,
  Grid
} from 'lucide-react';
import { SATQuestion } from '../types';

interface DomainAnalyticsProps {
  questions: SATQuestion[];
  onSelectSubdomainFilter: (category: string, value: string, groupingKey: string) => void;
}

export default function DomainAnalytics({ questions, onSelectSubdomainFilter }: DomainAnalyticsProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGrouping, setSelectedGrouping] = useState<string>('difficulty');

  // 1. Detect which potential subdomain fields are available in the loaded dataset
  const availableGroupingKeys = useMemo(() => {
    const defaultKeys = [
      { key: 'difficulty', label: 'Difficulty Level' },
      { key: 'module', label: 'Module Number' },
      { key: 'correct_answer', label: 'Correct Answer Key' }
    ];

    const detectedKeys: { key: string; label: string }[] = [];

    // Scan questions for other custom keys
    if (questions.length > 0) {
      const customKeyCandidates = ['sub_domain', 'subdomain', 'skill', 'topic', 'concept', 'subCategory', 'subcategory'];
      
      customKeyCandidates.forEach(candidate => {
        const hasField = questions.some(q => {
          const val = (q as any)[candidate];
          return val !== undefined && val !== null && val !== '';
        });
        
        if (hasField) {
          // Format label
          const label = candidate
            .replace(/_/g, ' ')
            .replace(/([A-Z])/g, ' $1')
            .trim()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
          detectedKeys.push({ key: candidate, label });
        }
      });
    }

    return [...defaultKeys, ...detectedKeys];
  }, [questions]);

  // Set initial grouping to a custom field if one was auto-detected (e.g. topic or skill)
  React.useEffect(() => {
    const custom = availableGroupingKeys.find(g => ['topic', 'skill', 'sub_domain', 'subdomain'].includes(g.key));
    if (custom) {
      setSelectedGrouping(custom.key);
    } else if (availableGroupingKeys.length > 0) {
      // Keep difficulty or first available
    }
  }, [availableGroupingKeys]);

  // 2. Perform grouping and analytics calculation
  const analyticsData = useMemo(() => {
    const domainMap: Record<string, {
      name: string;
      total: number;
      approved: number;
      rejected: number;
      pending: number;
      subdomains: Record<string, {
        name: string;
        total: number;
        approved: number;
        rejected: number;
        pending: number;
      }>;
    }> = {};

    questions.forEach(q => {
      const domain = q.category || 'Uncategorized';
      
      // Extract sub-domain value based on chosen grouping key
      let subValue = (q as any)[selectedGrouping];
      if (subValue === undefined || subValue === null || subValue === '') {
        subValue = 'Not Specified';
      }
      
      // Ensure strings are cleanly represented
      const subKey = String(subValue);

      if (!domainMap[domain]) {
        domainMap[domain] = {
          name: domain,
          total: 0,
          approved: 0,
          rejected: 0,
          pending: 0,
          subdomains: {}
        };
      }

      const dData = domainMap[domain];
      dData.total++;
      
      const status = q.reviewStatus || 'pending';
      if (status === 'approved') dData.approved++;
      else if (status === 'rejected') dData.rejected++;
      else dData.pending++;

      if (!dData.subdomains[subKey]) {
        dData.subdomains[subKey] = {
          name: subKey,
          total: 0,
          approved: 0,
          rejected: 0,
          pending: 0
        };
      }

      const sData = dData.subdomains[subKey];
      sData.total++;
      if (status === 'approved') sData.approved++;
      else if (status === 'rejected') sData.rejected++;
      else sData.pending++;
    });

    return Object.values(domainMap);
  }, [questions, selectedGrouping]);

  // 3. Filtered analytics based on search query (search domains or sub-domains)
  const filteredAnalytics = useMemo(() => {
    if (!searchQuery) return analyticsData;
    const query = searchQuery.toLowerCase();
    
    return analyticsData.filter(d => {
      const matchDomain = d.name.toLowerCase().includes(query);
      const matchSubdomains = Object.keys(d.subdomains).some(sub => 
        sub.toLowerCase().includes(query)
      );
      return matchDomain || matchSubdomains;
    });
  }, [analyticsData, searchQuery]);

  // 4. Calculate aggregate metric highlights
  const aggregates = useMemo(() => {
    const totalQuestions = questions.length;
    const domainCount = analyticsData.length;
    
    let maxDomainName = 'None';
    let maxDomainSize = 0;
    
    analyticsData.forEach(d => {
      if (d.total > maxDomainSize) {
        maxDomainSize = d.total;
        maxDomainName = d.name;
      }
    });

    const approvedCount = questions.filter(q => q.reviewStatus === 'approved').length;
    const overallProgress = totalQuestions > 0 ? Math.round((approvedCount / totalQuestions) * 100) : 0;

    return {
      totalQuestions,
      domainCount,
      maxDomainName,
      maxDomainSize,
      overallProgress
    };
  }, [questions, analyticsData]);

  const getPercentage = (value: number, total: number) => {
    if (total === 0) return 0;
    return Math.round((value / total) * 100);
  };

  const getGroupingLabel = (key: string) => {
    return availableGroupingKeys.find(g => g.key === key)?.label || key;
  };

  if (questions.length === 0) {
    return (
      <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-12 text-center flex flex-col items-center justify-center">
        <div className="w-12 h-12 rounded-full bg-[#f2f2f3] border border-[#e4e4e7] flex items-center justify-center text-zinc-500 mb-3.5">
          <PieChart className="w-5 h-5" />
        </div>
        <h4 className="text-sm font-bold text-zinc-900">No analytics data available</h4>
        <p className="text-xs text-zinc-500 mt-1 max-w-sm leading-relaxed">
          Upload an SAT question JSON bank manually to unlock deep domain and sub-domain breakdowns.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      
      {/* 1. Metric highlights banner grids */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        
        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-4.5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-indigo-50 text-[#4f46e5] border border-indigo-200 flex items-center justify-center shrink-0">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[11px] uppercase font-bold text-zinc-500 tracking-wider">Total Domains</p>
            <h3 className="text-xl font-extrabold text-zinc-900 font-mono mt-0.5">{aggregates.domainCount}</h3>
          </div>
        </div>

        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-4.5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 border border-emerald-200 flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[11px] uppercase font-bold text-zinc-500 tracking-wider">Overall Coverage</p>
            <h3 className="text-xl font-extrabold text-zinc-900 font-mono mt-0.5">{aggregates.overallProgress}%</h3>
          </div>
        </div>

        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-4.5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 flex items-center justify-center shrink-0">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[11px] uppercase font-bold text-zinc-500 tracking-wider">Largest Domain</p>
            <h3 className="text-sm font-extrabold text-zinc-900 truncate max-w-[140px] mt-0.5" title={aggregates.maxDomainName}>
              {aggregates.maxDomainName}
            </h3>
            <p className="text-[11px] text-zinc-500 font-mono">({aggregates.maxDomainSize} items)</p>
          </div>
        </div>

        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-4.5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-zinc-100 text-zinc-600 border border-[#e4e4e7] flex items-center justify-center shrink-0">
            <Grid className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[11px] uppercase font-bold text-zinc-500 tracking-wider">Grouped By</p>
            <h3 className="text-sm font-extrabold text-zinc-900 truncate max-w-[140px] mt-0.5">
              {getGroupingLabel(selectedGrouping)}
            </h3>
            <p className="text-[11px] text-zinc-500 font-mono">Sub-domain identifier</p>
          </div>
        </div>
      </div>

      {/* 2. Control Row: Grouping selector & domain search */}
      <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-4 flex flex-col sm:flex-row gap-4 justify-between items-stretch sm:items-center">
        
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <label className="text-xs font-bold text-zinc-500 whitespace-nowrap flex items-center gap-1.5 shrink-0 select-none">
            <Sparkles className="w-3.5 h-3.5 text-indigo-600" /> Choose Sub-domain attribute:
          </label>
          <div className="flex flex-wrap gap-1.5">
            {availableGroupingKeys.map((g) => (
              <button
                key={g.key}
                onClick={() => setSelectedGrouping(g.key)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
                  selectedGrouping === g.key
                    ? 'bg-[#6366f1] text-white border-[#6366f1] shadow-sm shadow-indigo-500/10'
                    : 'bg-[#f2f2f3] text-zinc-500 border-[#e4e4e7] hover:text-zinc-900 hover:bg-[#e4e4e7]'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>

        {/* Local Search */}
        <div className="relative w-full sm:w-72">
          <span className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
            <Search className="h-4 w-4 text-zinc-500" />
          </span>
          <input
            type="text"
            placeholder="Search domain or subdomain..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full pl-9 pr-4 py-1.5 border border-[#e4e4e7] rounded-lg text-xs bg-white text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1] transition-all placeholder:text-zinc-500"
          />
        </div>
      </div>

      {/* 3. Domain Analytics Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <AnimatePresence mode="popLayout">
          {filteredAnalytics.map((domain, idx) => {
            const progress = getPercentage(domain.approved, domain.total);
            const isFullyApproved = domain.approved === domain.total && domain.total > 0;
            
            return (
              <motion.div
                key={domain.name}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: idx * 0.04 }}
                className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-5 shadow-sm hover:border-[#d4d4d8] transition-all flex flex-col justify-between"
              >
                <div>
                  {/* Domain Card Header */}
                  <div className="flex justify-between items-start gap-2.5 pb-3.5 border-b border-[#e4e4e7] mb-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5">
                        <BookOpen className="w-4 h-4 text-indigo-600" />
                        <h4 className="text-sm font-bold text-zinc-900 tracking-tight" title={domain.name}>
                          {domain.name}
                        </h4>
                      </div>
                      <p className="text-[11px] text-zinc-500 font-mono">
                        {domain.total} total items • {domain.approved} approved
                      </p>
                    </div>
                    
                    <div className="text-right shrink-0">
                      <span className={`text-[12px] font-mono font-bold px-2 py-0.5 rounded-full ${
                        isFullyApproved 
                          ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' 
                          : 'bg-[#f2f2f3] text-zinc-500 border border-[#e4e4e7]'
                      }`}>
                        {progress}% Done
                      </span>
                    </div>
                  </div>

                  {/* Domain progress completion bar */}
                  <div className="space-y-1.5 mb-5">
                    <div className="w-full h-1.5 bg-[#f2f2f3] rounded-full overflow-hidden flex">
                      <div 
                        style={{ width: `${getPercentage(domain.approved, domain.total)}%` }} 
                        className="h-full bg-emerald-500" 
                        title={`Approved: ${domain.approved}`}
                      />
                      <div 
                        style={{ width: `${getPercentage(domain.pending, domain.total)}%` }} 
                        className="h-full bg-zinc-600" 
                        title={`Pending: ${domain.pending}`}
                      />
                      <div 
                        style={{ width: `${getPercentage(domain.rejected, domain.total)}%` }} 
                        className="h-full bg-rose-500" 
                        title={`Rejected: ${domain.rejected}`}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] font-mono font-bold text-zinc-500">
                      <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Approved ({domain.approved})</span>
                      <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-zinc-600" /> Pending ({domain.pending})</span>
                      <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" /> Rejected ({domain.rejected})</span>
                    </div>
                  </div>

                  {/* Sub-domain list breakdown heading */}
                  <div className="text-[11px] uppercase font-bold text-zinc-500 tracking-wider mb-2 select-none">
                    Sub-domain Level breakdown ({getGroupingLabel(selectedGrouping)}):
                  </div>

                  {/* Sub-domain items loop */}
                  <div className="space-y-2 border border-[#e4e4e7] rounded-lg p-2 max-h-[220px] overflow-y-auto bg-white">
                    {(Object.values(domain.subdomains) as Array<{ name: string; total: number; approved: number; rejected: number; pending: number; }>).map((sub) => {
                      const subProgress = getPercentage(sub.approved, sub.total);
                      return (
                        <div 
                          key={sub.name}
                          className="flex items-center justify-between text-xs py-2 px-2.5 rounded-md bg-[#fafafa] border border-[#e4e4e7] hover:border-[#d4d4d8] transition-all group"
                        >
                          <div className="space-y-0.5 truncate pr-2">
                            <div className="font-semibold text-zinc-600 capitalize truncate" title={sub.name}>
                              {sub.name}
                            </div>
                            <div className="text-[11px] text-zinc-500 font-mono flex items-center gap-2">
                              <span>{sub.total} questions</span>
                              <span>•</span>
                              <span className="text-emerald-600">{sub.approved} approved</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-3 shrink-0">
                            {/* Small progress meter */}
                            <div className="w-16 h-1 bg-[#f2f2f3] rounded-full overflow-hidden hidden sm:block">
                              <div 
                                style={{ width: `${subProgress}%` }}
                                className="h-full bg-[#6366f1]"
                              />
                            </div>
                            
                            {/* Action navigation link */}
                            <button
                              onClick={() => onSelectSubdomainFilter(domain.name, sub.name, selectedGrouping)}
                              className="text-[11px] text-zinc-500 group-hover:text-white bg-[#f2f2f3] group-hover:bg-[#6366f1] p-1 rounded-md transition-all flex items-center gap-0.5 cursor-pointer"
                              title="Go to curate this sub-domain"
                            >
                              <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            );
          })}

          {filteredAnalytics.length === 0 && (
            <div className="lg:col-span-2 py-12 text-center text-zinc-500 text-xs italic">
              No matching domain categories found for your search query.
            </div>
          )}
        </AnimatePresence>
      </div>

    </div>
  );
}
