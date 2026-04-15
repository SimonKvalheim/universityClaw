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

export default function StudyPage() {
  const [concepts, setConcepts] = useState<ConceptSummary[]>([]);
  const [pendingGroups, setPendingGroups] = useState<PendingGroup[]>([]);
  const [stats, setStats] = useState<ConceptStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [conceptsRes, pendingRes] = await Promise.all([
        fetch('/api/study/concepts'),
        fetch('/api/study/concepts/pending'),
      ]);
      const conceptsData = await conceptsRes.json() as { concepts: ConceptSummary[]; stats: ConceptStats };
      const pendingData = await pendingRes.json() as { groups: PendingGroup[] };
      setConcepts(conceptsData.concepts ?? []);
      setStats(conceptsData.stats ?? null);
      setPendingGroups(pendingData.groups ?? []);
    } catch {
      // silently fail; data stays stale
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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

  return (
    <div className="max-w-5xl space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Study</h2>
        {stats && (
          <p className="text-sm text-gray-500">
            {stats.active} active · {stats.pending} pending · {stats.domains} domains
          </p>
        )}
      </div>

      {/* Section 1 — Pending Approval */}
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

      {/* Section 2 — Active Concepts */}
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
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-48">Mastery</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-16">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800 bg-gray-950">
                {concepts.map((concept) => (
                  <tr key={concept.id} className="hover:bg-gray-900 transition-colors">
                    <td className="px-4 py-3 text-gray-100">
                      <span className="font-medium">{concept.title}</span>
                      {concept.subdomain && (
                        <span className="ml-1.5 text-xs text-gray-500">{concept.subdomain}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400">{concept.domain ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-400">
                      {concept.bloomCeiling === 0 ? '—' : (BLOOM_LABELS[concept.bloomCeiling] ?? `L${concept.bloomCeiling}`)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-blue-500"
                            style={{ width: `${Math.min(100, Math.round(concept.masteryOverall * 100))}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500 w-8 text-right">
                          {Math.round(concept.masteryOverall * 100)}%
                        </span>
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
