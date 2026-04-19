'use client';

import { useEffect, useState } from 'react';
import type { TokenUsage } from './rates';

interface StatsResponse {
  todayUsd: number;
  monthUsd: number;
  budgetUsd: number | null;
}

interface CostPanelProps {
  sessionCostUsd: number;
  sessionTotals: TokenUsage;
}

function formatUsd(n: number): string {
  return '$' + n.toFixed(4);
}

function formatShortUsd(n: number): string {
  return '$' + n.toFixed(2);
}

export function CostPanel({ sessionCostUsd, sessionTotals }: CostPanelProps) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/voice/stats')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`stats ${r.status}`))))
      .then((s: StatsResponse) => {
        if (!cancelled) setStats(s);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const overBudget =
    stats?.budgetUsd != null && stats.monthUsd + sessionCostUsd > stats.budgetUsd;

  const todayTotal = (stats?.todayUsd ?? 0) + sessionCostUsd;
  const monthTotal = (stats?.monthUsd ?? 0) + sessionCostUsd;

  return (
    <div className="flex items-center gap-6 border-t border-neutral-800 bg-neutral-950 px-4 py-3 text-sm">
      <div title={tokenBreakdownTitle(sessionTotals)}>
        <div className="text-[10px] uppercase tracking-wide text-neutral-500">Session</div>
        <div className="font-mono text-neutral-100">{formatUsd(sessionCostUsd)}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-neutral-500">Today</div>
        <div className="font-mono text-neutral-300">{formatShortUsd(todayTotal)}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-neutral-500">This month</div>
        <div className="font-mono text-neutral-300">{formatShortUsd(monthTotal)}</div>
      </div>
      {stats?.budgetUsd != null && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Budget</div>
          <div className={'font-mono ' + (overBudget ? 'text-amber-400' : 'text-neutral-500')}>
            {formatShortUsd(stats.budgetUsd)}
          </div>
        </div>
      )}
      {overBudget && (
        <div className="rounded bg-amber-900/40 px-2 py-1 text-xs text-amber-200">
          Monthly budget exceeded
        </div>
      )}
      {error && (
        <div className="text-xs text-red-400">stats unavailable: {error}</div>
      )}
    </div>
  );
}

function tokenBreakdownTitle(t: TokenUsage): string {
  return `textIn: ${t.textIn}\ntextOut: ${t.textOut}\naudioIn: ${t.audioIn}\naudioOut: ${t.audioOut}`;
}
