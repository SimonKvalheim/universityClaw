'use client';

import { useState, useEffect, use } from 'react';
import type { ConceptDetail } from '@/lib/study-db';

const MASTERY_THRESHOLD = 10.0;

const BLOOM_LABELS: Record<number, string> = {
  1: 'Remember',
  2: 'Understand',
  3: 'Apply',
  4: 'Analyse',
  5: 'Evaluate',
  6: 'Create',
};

const TYPE_DISPLAY: Record<string, { label: string; color: string }> = {
  card_review: { label: 'Card', color: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  elaboration: { label: 'Elaboration', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  self_explain: { label: 'Self-explain', color: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
  concept_map: { label: 'Concept map', color: 'bg-teal-500/20 text-teal-300 border-teal-500/30' },
  comparison: { label: 'Comparison', color: 'bg-pink-500/20 text-pink-300 border-pink-500/30' },
  case_analysis: { label: 'Case analysis', color: 'bg-orange-500/20 text-orange-300 border-orange-500/30' },
  synthesis: { label: 'Synthesis', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  socratic: { label: 'Socratic', color: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' },
};

const CARD_TYPE_LABEL: Record<string, string> = {
  basic: 'Basic',
  cloze: 'Cloze',
  reversed: 'Reversed',
};

const STATE_STYLES: Record<string, string> = {
  mastered: 'bg-green-500/20 text-green-300 border-green-500/30',
  reviewing: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  learning: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  new: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
};

function MasteryBar({ value, label }: { value: number; label: string }) {
  const pct = Math.min(100, Math.round((value / MASTERY_THRESHOLD) * 100));
  const colorClass =
    pct >= 70
      ? 'bg-green-500'
      : pct >= 30
        ? 'bg-yellow-400'
        : 'bg-gray-600';

  return (
    <div className="flex items-center gap-3">
      <span className="w-24 text-xs text-gray-400 shrink-0">{label}</span>
      <div className="flex-1 h-2.5 rounded-full bg-gray-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${colorClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-20 text-xs text-gray-500 text-right shrink-0">
        {Math.round(value * 10) / 10} / {MASTERY_THRESHOLD}
      </span>
    </div>
  );
}

function QualityDots({ quality }: { quality: number }) {
  return (
    <span className="inline-flex gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={`inline-block w-1.5 h-1.5 rounded-full ${i < quality ? 'bg-green-400' : 'bg-gray-700'}`}
        />
      ))}
    </span>
  );
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function ConceptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [concept, setConcept] = useState<ConceptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateMsg, setGenerateMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/study/concepts/${encodeURIComponent(id)}`)
      .then((res) => res.json())
      .then((data: { concept?: ConceptDetail; error?: string }) => {
        if (data.error) {
          setError(data.error);
        } else if (data.concept) {
          setConcept(data.concept);
        }
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [id]);

  const handleGenerate = async () => {
    if (!concept || generating) return;
    setGenerating(true);
    setGenerateMsg(null);
    try {
      const bloomLevel = Math.max(1, concept.bloomCeiling || 1);
      const res = await fetch('/api/study/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conceptId: concept.id, bloomLevel }),
      });
      if (res.ok) {
        setGenerateMsg('Generation requested — activities will appear shortly.');
      } else {
        const data = (await res.json()) as { error?: string };
        setGenerateMsg(`Error: ${data.error ?? 'Unknown error'}`);
      }
    } catch {
      setGenerateMsg('Failed to request generation.');
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-gray-500">Loading...</p>
      </div>
    );
  }

  if (error || !concept) {
    return (
      <div className="max-w-5xl space-y-4">
        <a href="/study" className="text-sm text-blue-400 hover:text-blue-300">← Back to Study</a>
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
          <p className="text-sm text-red-400">{error ?? 'Concept not found.'}</p>
        </div>
      </div>
    );
  }

  const masteryLevels = [
    { label: `L1 — ${BLOOM_LABELS[1]}`, value: concept.masteryL1 },
    { label: `L2 — ${BLOOM_LABELS[2]}`, value: concept.masteryL2 },
    { label: `L3 — ${BLOOM_LABELS[3]}`, value: concept.masteryL3 },
    { label: `L4 — ${BLOOM_LABELS[4]}`, value: concept.masteryL4 },
    { label: `L5 — ${BLOOM_LABELS[5]}`, value: concept.masteryL5 },
    { label: `L6 — ${BLOOM_LABELS[6]}`, value: concept.masteryL6 },
  ];

  const maxMethodQuality = Math.max(
    ...concept.methodEffectiveness.map((m) => m.avgQuality),
    1,
  );

  return (
    <div className="max-w-5xl space-y-8">
      {/* Header */}
      <div className="space-y-3">
        <a href="/study" className="text-sm text-blue-400 hover:text-blue-300 transition-colors">
          ← Back to Study
        </a>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold text-gray-100">{concept.title}</h2>
            <div className="flex flex-wrap items-center gap-2">
              {concept.domain && (
                <span className="px-2 py-0.5 rounded-md bg-gray-800 border border-gray-700 text-xs text-gray-300">
                  {concept.domain}
                </span>
              )}
              {concept.subdomain && (
                <span className="px-2 py-0.5 rounded-md bg-gray-800 border border-gray-700 text-xs text-gray-400">
                  {concept.subdomain}
                </span>
              )}
              {concept.course && (
                <span className="px-2 py-0.5 rounded-md bg-gray-800 border border-gray-700 text-xs text-gray-400">
                  {concept.course}
                </span>
              )}
              <span className="text-xs text-gray-600">
                Bloom ceiling: {concept.bloomCeiling > 0 ? `L${concept.bloomCeiling} — ${BLOOM_LABELS[concept.bloomCeiling] ?? `L${concept.bloomCeiling}`}` : '—'}
              </span>
            </div>
          </div>
          {concept.vaultNotePath && (
            <a
              href={`obsidian://open?path=${encodeURIComponent(concept.vaultNotePath)}`}
              className="shrink-0 px-3 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 border border-gray-700 text-xs text-gray-300 transition-colors"
            >
              Open in Vault
            </a>
          )}
        </div>
      </div>

      {/* Mastery breakdown */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Mastery Breakdown</h3>
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-3">
          {masteryLevels.map((level, idx) => (
            <MasteryBar
              key={idx}
              label={level.label}
              value={level.value}
            />
          ))}
        </div>
      </section>

      {/* Activities */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Activities
            <span className="ml-2 text-gray-600 normal-case font-normal">({concept.totalActivities})</span>
          </h3>
          <div className="flex gap-2">
            {concept.activities.length > 0 && (
              <a
                href={`/study/session?conceptId=${encodeURIComponent(concept.id)}`}
                className="px-3 py-1.5 rounded-md bg-green-700 hover:bg-green-600 text-white text-xs font-medium transition-colors"
              >
                Practice ({concept.activities.length})
              </a>
            )}
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="px-3 py-1.5 rounded-md bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-medium transition-colors"
            >
              {generating ? 'Requesting...' : 'Generate more'}
            </button>
          </div>
        </div>
        {generateMsg && (
          <p className={`text-xs ${generateMsg.startsWith('Error') || generateMsg.startsWith('Failed') ? 'text-red-400' : 'text-green-400'}`}>
            {generateMsg}
          </p>
        )}
        {concept.activities.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 text-center">
            <p className="text-sm text-gray-500">No activities generated yet.</p>
          </div>
        ) : (
          <div className="grid gap-2">
            {concept.activities.map((activity) => {
              const typeInfo = TYPE_DISPLAY[activity.activityType] ?? {
                label: activity.activityType,
                color: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
              };
              const stateStyle = STATE_STYLES[activity.masteryState] ?? STATE_STYLES.new;
              const isDue = new Date(activity.dueAt) <= new Date();

              return (
                <div
                  key={activity.id}
                  className="rounded-lg border border-gray-800 bg-gray-900 hover:bg-gray-900/80 transition-colors px-4 py-3"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200 leading-relaxed">
                        {activity.prompt}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border ${typeInfo.color}`}>
                          {typeInfo.label}
                          {activity.cardType && CARD_TYPE_LABEL[activity.cardType] && (
                            <span className="opacity-70">· {CARD_TYPE_LABEL[activity.cardType]}</span>
                          )}
                        </span>
                        <span className="text-[11px] text-gray-500">
                          L{activity.bloomLevel} {BLOOM_LABELS[activity.bloomLevel] ?? ''}
                        </span>
                        <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded border ${stateStyle}`}>
                          {activity.masteryState}
                        </span>
                        {isDue && activity.masteryState !== 'mastered' && (
                          <span className="text-[11px] text-amber-400">Due</span>
                        )}
                        <span className="text-[11px] text-gray-600 ml-auto shrink-0">
                          {formatDate(activity.dueAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Activity history */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Activity History</h3>
        {concept.recentLogs.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 text-center">
            <p className="text-sm text-gray-500">No history yet.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 border-b border-gray-800">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-32">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-20">Bloom</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-28">Quality</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Method</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800 bg-gray-950">
                {concept.recentLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-900 transition-colors">
                    <td className="px-4 py-3 text-gray-400 text-xs">{formatDate(log.reviewedAt)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded border ${(TYPE_DISPLAY[log.activityType] ?? { color: 'bg-gray-500/15 text-gray-400 border-gray-500/20' }).color}`}>
                        {(TYPE_DISPLAY[log.activityType] ?? { label: log.activityType }).label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">L{log.bloomLevel}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <QualityDots quality={log.quality} />
                        <span className="text-xs text-gray-500">{log.quality}/5</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{log.evaluationMethod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Method effectiveness */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Method Effectiveness</h3>
        {concept.methodEffectiveness.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 text-center">
            <p className="text-sm text-gray-500">No data yet.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-3">
            {concept.methodEffectiveness.map((method) => {
              const pct = Math.round((method.avgQuality / maxMethodQuality) * 100);
              return (
                <div key={method.activityType} className="flex items-center gap-3">
                  <span className={`w-36 shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded border text-center ${(TYPE_DISPLAY[method.activityType] ?? { color: 'bg-gray-500/15 text-gray-400 border-gray-500/20' }).color}`}>
                    {(TYPE_DISPLAY[method.activityType] ?? { label: method.activityType }).label}
                  </span>
                  <div className="flex-1 h-2.5 rounded-full bg-gray-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-28 text-xs text-gray-500 text-right shrink-0">
                    {method.avgQuality.toFixed(1)} avg · {method.count} reviews
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Related concepts */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Related Concepts</h3>
        {concept.relatedConcepts.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 text-center">
            <p className="text-sm text-gray-500">No related concepts found.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
            <div className="flex flex-wrap gap-2">
              {concept.relatedConcepts.map((related) => (
                <a
                  key={related.id}
                  href={`/study/concepts/${related.id}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 border border-gray-700 text-sm text-gray-300 hover:text-gray-100 transition-colors"
                >
                  {related.title}
                  <span className="text-xs text-gray-500">{related.role}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Prerequisites */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Prerequisites</h3>
        {concept.prerequisites.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 text-center">
            <p className="text-sm text-gray-500">No prerequisites defined.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-2">
            {concept.prerequisites.map((prereq) => {
              const isWeak = prereq.masteryOverall < 0.3;
              return (
                <a
                  key={prereq.id}
                  href={`/study/concepts/${prereq.id}`}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-md border transition-colors ${
                    isWeak
                      ? 'border-amber-700 bg-amber-950 hover:bg-amber-900'
                      : 'border-gray-700 bg-gray-800 hover:bg-gray-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {isWeak && (
                      <span className="text-amber-400 text-xs font-medium">Weak</span>
                    )}
                    <span className={`text-sm font-medium ${isWeak ? 'text-amber-200' : 'text-gray-200'}`}>
                      {prereq.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span>
                      Bloom {prereq.bloomCeiling > 0 ? `L${prereq.bloomCeiling}` : '—'}
                    </span>
                    <span>
                      {Math.round(prereq.masteryOverall * 100)}% overall
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
