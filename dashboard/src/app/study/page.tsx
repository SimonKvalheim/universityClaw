'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ConceptSummary, PendingGroup, ConceptStats } from '@/lib/study-db';

const BLOOM_LABELS: Record<number, string> = {
  1: 'L1',
  2: 'L2',
  3: 'L3',
  4: 'L4',
  5: 'L5',
  6: 'L6',
};

const MASTERY_THRESHOLD = 10.0;

const BLOOM_COLORS: Record<number, string> = {
  1: 'bg-blue-300',
  2: 'bg-blue-400',
  3: 'bg-blue-500',
  4: 'bg-blue-600',
  5: 'bg-blue-700',
  6: 'bg-blue-800',
};

interface PlanSummary {
  id: string;
  title: string;
  strategy: string;
  status: string;
  progressPercent: number;
}

interface SessionPreview {
  blocks: Array<{
    type: string;
    activities: Array<{
      activityType: string;
      bloomLevel: number;
    }>;
  }>;
  totalActivities: number;
  estimatedMinutes: number;
  domainsCovered: string[];
}

interface RetentionRate {
  retentionRate: number;
  totalReviews: number;
  correctReviews: number;
}

interface BloomDistributionItem {
  bloomLevel: number;
  count: number;
  percentage: number;
}

interface MethodEffectivenessItem {
  activityType: string;
  avgQuality: number;
  count: number;
}

interface ActivityTimeSeriesItem {
  date: string;
  count: number;
  avgQuality: number;
}

interface Calibration {
  calibrationScore: number | null;
  dataPoints: number;
}

interface StudyStats {
  retentionRate: RetentionRate;
  bloomDistribution: BloomDistributionItem[];
  methodEffectiveness: MethodEffectivenessItem[];
  activityTimeSeries: ActivityTimeSeriesItem[];
  calibration: Calibration;
  period: { days: number; from: string; to: string };
}

export default function StudyPage() {
  const [concepts, setConcepts] = useState<ConceptSummary[]>([]);
  const [pendingGroups, setPendingGroups] = useState<PendingGroup[]>([]);
  const [stats, setStats] = useState<ConceptStats | null>(null);
  const [session, setSession] = useState<SessionPreview | null>(null);
  const [streak, setStreak] = useState<number>(0);
  const [activePlans, setActivePlans] = useState<PlanSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [analyticsPeriod, setAnalyticsPeriod] = useState<7 | 30 | 9999>(7);
  const [analyticsData, setAnalyticsData] = useState<StudyStats | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [conceptsRes, pendingRes, sessionRes, streakRes, plansRes] = await Promise.all([
        fetch('/api/study/concepts'),
        fetch('/api/study/concepts/pending'),
        fetch('/api/study/session'),
        fetch('/api/study/streak'),
        fetch('/api/study/plans'),
      ]);
      const conceptsData = await conceptsRes.json() as { concepts: ConceptSummary[]; stats: ConceptStats };
      const pendingData = await pendingRes.json() as { groups: PendingGroup[] };
      const sessionData = await sessionRes.json() as { session: SessionPreview };
      const streakData = await streakRes.json() as { streak: number };
      const plansData = await plansRes.json() as { plans: PlanSummary[] };
      setConcepts(conceptsData.concepts ?? []);
      setStats(conceptsData.stats ?? null);
      setPendingGroups(pendingData.groups ?? []);
      setSession(sessionData.session ?? null);
      setStreak(streakData.streak ?? 0);
      const allPlans: PlanSummary[] = plansData.plans ?? [];
      setActivePlans(
        allPlans
          .filter((p) => p.status === 'active')
          .sort((a, b) => b.progressPercent - a.progressPercent)
          .slice(0, 3),
      );
    } catch {
      // silently fail; data stays stale
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAnalytics = useCallback(async (days: number) => {
    setAnalyticsLoading(true);
    try {
      const res = await fetch(`/api/study/stats?days=${days}`);
      const data = await res.json() as StudyStats;
      setAnalyticsData(data);
    } catch {
      // silently fail
    } finally {
      setAnalyticsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchAnalytics(analyticsPeriod);
  }, [fetchAnalytics, analyticsPeriod]);

  const approveDomain = useCallback(async (domain: string) => {
    await fetch('/api/study/concepts/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });
    await fetchData();
  }, [fetchData]);

  const approveConcept = useCallback(async (id: string) => {
    await fetch('/api/study/concepts/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conceptIds: [id] }),
    });
    await fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-gray-500">Loading...</p>
      </div>
    );
  }

  // Build activity type breakdown for the session card
  const activityBreakdown: Record<string, number> = {};
  if (session) {
    for (const block of session.blocks) {
      for (const activity of block.activities) {
        const type = activity.activityType;
        activityBreakdown[type] = (activityBreakdown[type] ?? 0) + 1;
      }
    }
  }

  // Compute analytics summary values
  const totalActivities = analyticsData
    ? analyticsData.activityTimeSeries.reduce((sum, d) => sum + d.count, 0)
    : 0;

  const avgQuality = analyticsData && analyticsData.activityTimeSeries.length > 0
    ? analyticsData.activityTimeSeries.reduce((sum, d) => sum + d.avgQuality * d.count, 0) /
      Math.max(1, totalActivities)
    : null;

  const retentionPct = analyticsData ? Math.round(analyticsData.retentionRate.retentionRate * 100) : null;
  const calibrationPct = analyticsData?.calibration.calibrationScore != null
    ? Math.round(analyticsData.calibration.calibrationScore * 100)
    : null;

  const retentionColor =
    retentionPct == null
      ? 'text-gray-400'
      : retentionPct > 80
        ? 'text-green-400'
        : retentionPct > 60
          ? 'text-yellow-400'
          : 'text-red-400';

  const PERIOD_OPTIONS: Array<{ label: string; value: 7 | 30 | 9999 }> = [
    { label: '7 days', value: 7 },
    { label: '30 days', value: 30 },
    { label: 'All time', value: 9999 },
  ];

  return (
    <div className="max-w-5xl space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Study</h2>
        {stats && (
          <p className="text-sm text-gray-500">
            {stats.active} active · {stats.pending} pending · {stats.domains} domains
            {streak > 0 && (
              <span className="ml-2 text-amber-400 font-medium">🔥 {streak} day streak</span>
            )}
          </p>
        )}
      </div>

      {/* Section 0 — Today's Session */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Today&apos;s Session</h3>
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
          {session && session.totalActivities > 0 ? (
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <p className="text-gray-100 font-medium">
                  {session.totalActivities} {session.totalActivities === 1 ? 'activity' : 'activities'} due
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {Object.entries(activityBreakdown).map(([type, count]) => (
                    <span key={type} className="text-xs text-gray-500">
                      {count} {type}
                    </span>
                  ))}
                  {session.estimatedMinutes > 0 && (
                    <span className="text-xs text-gray-600">~{session.estimatedMinutes} min</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => { window.location.href = '/study/session'; }}
                className="shrink-0 px-4 py-2 rounded-md bg-blue-700 hover:bg-blue-600 text-white text-sm font-medium transition-colors"
              >
                Start Session
              </button>
            </div>
          ) : (
            <p className="text-sm text-gray-500">All caught up! No activities due today.</p>
          )}
        </div>
      </section>

      {/* Section 1 — Plans */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Plans
            {activePlans.length > 0 && (
              <span className="ml-2 text-gray-600 normal-case font-normal">({activePlans.length} active)</span>
            )}
          </h3>
          <a
            href="/study/plan"
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            View All Plans →
          </a>
        </div>
        {activePlans.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-center">
            <p className="text-sm text-gray-500">No active plans. <a href="/study/plan" className="text-blue-400 hover:text-blue-300">Create one →</a></p>
          </div>
        ) : (
          <div className="space-y-2">
            {activePlans.map((plan) => (
              <a
                key={plan.id}
                href={`/study/plan`}
                className="flex items-center gap-4 rounded-lg border border-gray-800 bg-gray-900 p-3 hover:border-gray-700 transition-colors"
              >
                <span className="text-sm text-gray-100 font-medium min-w-0 truncate flex-1">{plan.title}</span>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="w-24 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-500 rounded-full"
                      style={{ width: `${Math.min(100, Math.max(0, plan.progressPercent))}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500 w-8 text-right">{Math.round(plan.progressPercent)}%</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </section>

      {/* Section 2 — Analytics */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Analytics</h3>
          <div className="flex gap-1">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setAnalyticsPeriod(opt.value)}
                className={`text-xs px-3 py-1 rounded-md transition-colors ${
                  analyticsPeriod === opt.value
                    ? 'bg-blue-700 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {analyticsLoading ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center">
            <p className="text-sm text-gray-500">Loading analytics...</p>
          </div>
        ) : analyticsData ? (
          <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                <p className="text-xs text-gray-500 mb-1">Retention rate</p>
                <p className={`text-2xl font-semibold ${retentionColor}`}>
                  {retentionPct != null ? `${retentionPct}%` : '—'}
                </p>
                <p className="text-xs text-gray-600 mt-0.5">
                  {analyticsData.retentionRate.correctReviews}/{analyticsData.retentionRate.totalReviews} reviews
                </p>
              </div>

              <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                <p className="text-xs text-gray-500 mb-1">Activities</p>
                <p className="text-2xl font-semibold text-gray-100">{totalActivities}</p>
                <p className="text-xs text-gray-600 mt-0.5">this period</p>
              </div>

              <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                <p className="text-xs text-gray-500 mb-1">Avg quality</p>
                <p className="text-2xl font-semibold text-gray-100">
                  {avgQuality != null ? `${avgQuality.toFixed(1)} / 5` : '—'}
                </p>
                <p className="text-xs text-gray-600 mt-0.5">per activity</p>
              </div>

              <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                <p className="text-xs text-gray-500 mb-1">Calibration</p>
                <p className="text-2xl font-semibold text-gray-100">
                  {calibrationPct != null ? `${calibrationPct}%` : '—'}
                </p>
                <p className="text-xs text-gray-600 mt-0.5">
                  {analyticsData.calibration.dataPoints} data pts
                </p>
              </div>
            </div>

            {/* Bloom's distribution */}
            {analyticsData.bloomDistribution.length > 0 && (
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-2">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Bloom&apos;s distribution</p>
                <div className="flex h-5 rounded overflow-hidden">
                  {analyticsData.bloomDistribution.map((item) => (
                    <div
                      key={item.bloomLevel}
                      className={`${BLOOM_COLORS[item.bloomLevel] ?? 'bg-blue-500'}`}
                      style={{ width: `${item.percentage}%` }}
                      title={`L${item.bloomLevel}: ${item.count} (${Math.round(item.percentage)}%)`}
                    />
                  ))}
                </div>
                <div className="flex">
                  {analyticsData.bloomDistribution.map((item) => (
                    <div
                      key={item.bloomLevel}
                      style={{ width: `${item.percentage}%` }}
                      className="text-center overflow-hidden"
                    >
                      <span className="text-xs text-gray-500 whitespace-nowrap">
                        {item.percentage >= 8 ? `L${item.bloomLevel} ${Math.round(item.percentage)}%` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Method effectiveness */}
            {analyticsData.methodEffectiveness.length > 0 && (
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Method effectiveness</p>
                <div className="space-y-2">
                  {analyticsData.methodEffectiveness.map((method) => (
                    <div key={method.activityType} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300">{method.activityType}</span>
                        <span className="text-xs text-gray-500">
                          {method.avgQuality.toFixed(1)} / 5 · {method.count} activities
                        </span>
                      </div>
                      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-600 rounded-full"
                          style={{ width: `${(method.avgQuality / 5) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center">
            <p className="text-sm text-gray-500">No analytics data available.</p>
          </div>
        )}
      </section>

      {/* Section 3 — Pending Approval */}
      {pendingGroups.length > 0 && (
        <section className="space-y-4">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Pending Approval</h3>
          <div className="space-y-3">
            {pendingGroups.map((group) => {
              const domainLabel = group.domain ?? 'Uncategorised';
              return (
                <div key={group.domain ?? '\x00null'} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <span className="font-medium text-gray-100">{domainLabel}</span>
                      <span className="ml-2 text-xs text-gray-500">{group.concepts.length} concept{group.concepts.length !== 1 ? 's' : ''}</span>
                    </div>
                    {group.domain !== null && (
                      <button
                        onClick={() => approveDomain(group.domain!)}
                        className="text-xs px-3 py-1.5 rounded-md bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                      >
                        Approve all
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {group.concepts.map((concept) => (
                      <button
                        key={concept.id}
                        onClick={() => approveConcept(concept.id)}
                        title={concept.subdomain ?? undefined}
                        className="text-xs px-2.5 py-1 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-gray-100 border border-gray-700 transition-colors"
                      >
                        {concept.title}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Section 4 — Active Concepts */}
      <section className="space-y-4">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Active Concepts</h3>
        {concepts.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center">
            <p className="text-sm text-gray-500">No active concepts yet. Approve pending concepts above to get started.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 border-b border-gray-800">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Concept</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Domain</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-16">Bloom</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-40">Mastery</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-16">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800 bg-gray-950">
                {concepts.map((concept) => {
                  const levelValues = [
                    concept.masteryL1,
                    concept.masteryL2,
                    concept.masteryL3,
                    concept.masteryL4,
                    concept.masteryL5,
                    concept.masteryL6,
                  ];
                  return (
                    <tr key={concept.id} className="hover:bg-gray-900 transition-colors">
                      <td className="px-4 py-3 text-gray-100">
                        <a
                          href={`/study/concepts/${concept.id}`}
                          className="font-medium text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          {concept.title}
                        </a>
                        {concept.subdomain && (
                          <span className="ml-1.5 text-xs text-gray-500">{concept.subdomain}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-400">{concept.domain ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-400">
                        {concept.bloomCeiling === 0 ? '—' : (BLOOM_LABELS[concept.bloomCeiling] ?? `L${concept.bloomCeiling}`)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-0.5" title={`Overall: ${Math.round(concept.masteryOverall * 100)}%`}>
                          {levelValues.map((val, idx) => {
                            const pct = Math.min(100, Math.round((val / MASTERY_THRESHOLD) * 100));
                            // Progressively brighter blue as level increases
                            const opacityClass = idx < 2
                              ? 'opacity-40'
                              : idx < 4
                                ? 'opacity-70'
                                : 'opacity-100';
                            return (
                              <div
                                key={idx}
                                className="flex-1 h-2 rounded-sm bg-gray-800 overflow-hidden"
                                title={`L${idx + 1}: ${Math.round(val * 10) / 10} / ${MASTERY_THRESHOLD}`}
                              >
                                <div
                                  className={`h-full bg-blue-500 ${opacityClass}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {concept.dueCount > 0 ? (
                          <span className="text-xs font-medium text-amber-400">{concept.dueCount}</span>
                        ) : (
                          <span className="text-xs text-gray-600">0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
