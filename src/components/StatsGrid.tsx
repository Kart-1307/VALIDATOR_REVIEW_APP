import { motion } from 'motion/react';
import { Database, CheckCircle2, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { StatsSummary } from '../types';

interface StatsGridProps {
  stats: StatsSummary;
  onSelectStatusFilter: (status: 'all' | 'pending' | 'approved' | 'rejected' | 'needs_revision') => void;
  activeStatusFilter: 'all' | 'pending' | 'approved' | 'rejected' | 'needs_revision';
}

export default function StatsGrid({ stats, onSelectStatusFilter, activeStatusFilter }: StatsGridProps) {
  const cards = [
    {
      id: 'all' as const,
      label: 'Total Questions',
      value: stats.total,
      icon: Database,
      color: 'border-[#e4e4e7] text-zinc-700 bg-[#fafafa] hover:bg-[#f2f2f3] hover:border-[#d4d4d8]',
      activeColor: 'border-[#6366f1] ring-2 ring-indigo-500/20 text-zinc-900 bg-[#f2f2f3]',
      iconColor: 'text-zinc-500',
      activeIconColor: 'text-indigo-600',
      labelColor: 'text-zinc-500',
      activeLabelColor: 'text-indigo-600',
      descColor: 'text-zinc-500',
      activeDescColor: 'text-indigo-600/70',
      description: 'Imported test items'
    },
    {
      id: 'approved' as const,
      label: 'Approved',
      value: stats.approved,
      icon: CheckCircle2,
      color: 'border-[#e4e4e7] text-emerald-600 bg-[#fafafa] hover:bg-[#f2f2f3] hover:border-[#d4d4d8]',
      activeColor: 'border-[#10b981] ring-2 ring-emerald-500/20 text-zinc-900 bg-[rgba(16,185,129,0.05)]',
      iconColor: 'text-emerald-500/70',
      activeIconColor: 'text-emerald-600',
      labelColor: 'text-zinc-500',
      activeLabelColor: 'text-emerald-600',
      descColor: 'text-zinc-500',
      activeDescColor: 'text-emerald-600/70',
      description: 'Accepted into official bank'
    },
    {
      id: 'rejected' as const,
      label: 'Rejected',
      value: stats.rejected,
      icon: XCircle,
      color: 'border-[#e4e4e7] text-red-600 bg-[#fafafa] hover:bg-[#f2f2f3] hover:border-[#d4d4d8]',
      activeColor: 'border-[#ef4444] ring-2 ring-rose-500/20 text-zinc-900 bg-[rgba(239,68,68,0.05)]',
      iconColor: 'text-red-600/70',
      activeIconColor: 'text-rose-600',
      labelColor: 'text-zinc-500',
      activeLabelColor: 'text-rose-600',
      descColor: 'text-zinc-500',
      activeDescColor: 'text-rose-600/70',
      description: 'Excluded from test bank'
    },
    {
      id: 'needs_revision' as const,
      label: 'Needs Revision',
      value: stats.needsRevision,
      icon: AlertTriangle,
      color: 'border-[#e4e4e7] text-orange-600 bg-[#fafafa] hover:bg-[#f2f2f3] hover:border-[#d4d4d8]',
      activeColor: 'border-[#f97316] ring-2 ring-orange-500/20 text-zinc-900 bg-[rgba(249,115,22,0.05)]',
      iconColor: 'text-orange-600/70',
      activeIconColor: 'text-orange-600',
      labelColor: 'text-zinc-500',
      activeLabelColor: 'text-orange-600',
      descColor: 'text-zinc-500',
      activeDescColor: 'text-orange-600/70',
      description: 'Failed a validation check'
    },
    {
      id: 'pending' as const,
      label: 'Pending Review',
      value: stats.pending,
      icon: Clock,
      color: 'border-[#e4e4e7] text-amber-700 bg-[#fafafa] hover:bg-[#f2f2f3] hover:border-[#d4d4d8]',
      activeColor: 'border-[#f59e0b] ring-2 ring-amber-500/20 text-zinc-900 bg-[rgba(245,158,11,0.05)]',
      iconColor: 'text-amber-700/70',
      activeIconColor: 'text-amber-700',
      labelColor: 'text-zinc-500',
      activeLabelColor: 'text-amber-700',
      descColor: 'text-zinc-500',
      activeDescColor: 'text-amber-700/70',
      description: 'Awaiting administrator action'
    }
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      {cards.map((card, idx) => {
        const Icon = card.icon;
        const isActive = activeStatusFilter === card.id;
        
        return (
          <motion.button
            key={card.id}
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: idx * 0.05 }}
            onClick={() => onSelectStatusFilter(card.id)}
            className={`flex flex-col justify-between text-left p-5 rounded-xl border transition-all cursor-pointer shadow-sm ${
              isActive ? card.activeColor : card.color
            }`}
          >
            <div className="flex justify-between items-start w-full mb-3">
              <span className={`text-sm font-medium ${isActive ? card.activeLabelColor : card.labelColor}`}>{card.label}</span>
              <Icon className={`w-5 h-5 ${isActive ? card.activeIconColor : card.iconColor}`} />
            </div>
            
            <div>
              <div className="text-3xl font-bold tracking-tight mb-1">{card.value}</div>
              <p className={`text-xs font-normal ${isActive ? card.activeDescColor : card.descColor}`}>{card.description}</p>
            </div>
          </motion.button>
        );
      })}
    </div>
  );
}
