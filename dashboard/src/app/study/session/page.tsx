'use client';

import { useState, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnrichedActivity {
  activityId: string;
  conceptId: string;
  conceptTitle: string;
  domain: string | null;
  activityType: string;
  bloomLevel: number;
  prompt: string;
  referenceAnswer: string | null;
  cardType: string | null;
}

interface EnrichedBlock {
  type: 'new' | 'review' | 'stretch';
  activities: EnrichedActivity[];
}

interface SessionData {
  blocks: EnrichedBlock[];
  totalActivities: number;
  estimatedMinutes: number;
  domainsCovered: string[];
}

type Phase = 'loading' | 'pre_session' | 'in_progress' | 'post_session' | 'complete';

interface FlatActivity {
  activity: EnrichedActivity;
  blockType: 'new' | 'review' | 'stretch';
  blockIndex: number;
}

interface CompletionResult {
  logEntryId: string;
  newDueAt: string;
  advancement: {
    conceptId: string;
    conceptTitle: string;
    previousCeiling: number;
    newCeiling: number;
    generationNeeded: boolean;
  } | null;
  generationNeeded: boolean;
  deEscalation: string | null;
}

interface SessionStats {
  activitiesCompleted: number;
  avgQuality: number;
  totalTimeMs: number;
  qualities: number[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BLOCK_LABELS: Record<string, string> = {
  new: 'New Material',
  review: 'Review',
  stretch: 'Stretch',
};

const BLOOM_LABELS: Record<number, string> = {
  1: 'L1 Remember',
  2: 'L2 Understand',
  3: 'L3 Apply',
  4: 'L4 Analyse',
  5: 'L5 Evaluate',
  6: 'L6 Create',
};

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  card_review: 'Card Review',
  elaboration: 'Elaboration',
  self_explain: 'Self Explain',
  comparison: 'Comparison',
  case_analysis: 'Case Analysis',
  concept_map: 'Concept Map',
  synthesis: 'Synthesis',
  socratic: 'Socratic',
};

const QUALITY_LABELS: Record<number, string> = {
  0: 'Blackout',
  1: 'Wrong',
  2: 'Hard recall',
  3: 'Correct (difficult)',
  4: 'Correct (easy)',
  5: 'Perfect',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenBlocks(blocks: EnrichedBlock[]): FlatActivity[] {
  const flat: FlatActivity[] = [];
  blocks.forEach((block, blockIndex) => {
    block.activities.forEach((activity) => {
      flat.push({ activity, blockType: block.type, blockIndex });
    });
  });
  return flat;
}

function getUniqueConceptsFromBlocks(
  blocks: EnrichedBlock[],
): Array<{ conceptId: string; conceptTitle: string; domain: string | null }> {
  const seen = new Set<string>();
  const result: Array<{ conceptId: string; conceptTitle: string; domain: string | null }> = [];
  for (const block of blocks) {
    for (const activity of block.activities) {
      if (!seen.has(activity.conceptId)) {
        seen.add(activity.conceptId);
        result.push({
          conceptId: activity.conceptId,
          conceptTitle: activity.conceptTitle,
          domain: activity.domain,
        });
      }
    }
  }
  return result;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function calibrationColor(predicted: number, actual: number): string {
  const diff = predicted - actual;
  if (Math.abs(diff) <= 0.5) return 'text-green-400';
  if (diff > 0.5) return 'text-amber-400'; // overconfident
  return 'text-blue-400'; // underconfident
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function StudySessionPage() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // PRE_SESSION
  const [preConfidence, setPreConfidence] = useState<Record<string, number>>({});

  // IN_PROGRESS
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [flatActivities, setFlatActivities] = useState<FlatActivity[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [responseText, setResponseText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [selectedQuality, setSelectedQuality] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<CompletionResult | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStats>({
    activitiesCompleted: 0,
    avgQuality: 0,
    totalTimeMs: 0,
    qualities: [],
  });
  const activityStartTime = useRef<number>(Date.now());
  const sessionStartTime = useRef<number>(Date.now());

  // POST_SESSION
  const [reflection, setReflection] = useState('');
  const [reflectLoading, setReflectLoading] = useState(false);
  const [finalCalibrationScore, setFinalCalibrationScore] = useState<number | null>(null);

  // COMPLETE — store final stats snapshot
  const [completeStats, setCompleteStats] = useState<SessionStats | null>(null);

  // ---------------------------------------------------------------------------
  // LOADING: fetch session data
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (phase !== 'loading') return;
    fetch('/api/study/session')
      .then((r) => r.json())
      .then((data: { session?: SessionData; error?: string }) => {
        if (data.error) {
          setLoadError(data.error);
          return;
        }
        const session = data.session;
        if (!session || session.totalActivities === 0) {
          // No activities — stay on loading phase but show empty state
          setSessionData({ blocks: [], totalActivities: 0, estimatedMinutes: 0, domainsCovered: [] });
        } else {
          setSessionData(session);
          setPhase('pre_session');
        }
      })
      .catch((err: unknown) => {
        setLoadError(String(err));
      });
  }, [phase]);

  // ---------------------------------------------------------------------------
  // PRE_SESSION: begin session
  // ---------------------------------------------------------------------------

  async function handleBeginSession() {
    if (!sessionData) return;
    const res = await fetch('/api/study/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preConfidence }),
    });
    const data = (await res.json()) as { sessionId?: string; error?: string };
    if (!data.sessionId) return;
    setSessionId(data.sessionId);

    const flat = flattenBlocks(sessionData.blocks);
    setFlatActivities(flat);
    setCurrentIndex(0);
    setResponseText('');
    setSubmitted(false);
    setSelectedQuality(null);
    sessionStartTime.current = Date.now();
    activityStartTime.current = Date.now();
    setPhase('in_progress');
  }

  // ---------------------------------------------------------------------------
  // IN_PROGRESS: submit + quality rating
  // ---------------------------------------------------------------------------

  function handleSubmit() {
    if (!responseText.trim() && flatActivities[currentIndex]?.activity.activityType !== 'card_review') {
      return;
    }
    setSubmitted(true);
  }

  async function handleQualityRating(quality: number) {
    if (!sessionId) return;
    const flat = flatActivities[currentIndex];
    if (!flat) return;

    const responseTimeMs = Date.now() - activityStartTime.current;
    setSelectedQuality(quality);

    const res = await fetch('/api/study/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activityId: flat.activity.activityId,
        quality,
        sessionId,
        responseText,
        responseTimeMs,
      }),
    });
    const result = (await res.json()) as CompletionResult;
    setLastResult(result);

    // Accumulate stats
    setSessionStats((prev) => {
      const newQualities = [...prev.qualities, quality];
      const avg = newQualities.reduce((s, q) => s + q, 0) / newQualities.length;
      return {
        activitiesCompleted: prev.activitiesCompleted + 1,
        avgQuality: avg,
        totalTimeMs: Date.now() - sessionStartTime.current,
        qualities: newQualities,
      };
    });
  }

  async function handleSkip() {
    if (!sessionId) return;
    const flat = flatActivities[currentIndex];
    if (!flat) return;

    const responseTimeMs = Date.now() - activityStartTime.current;

    await fetch('/api/study/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activityId: flat.activity.activityId,
        quality: 0,
        sessionId,
        responseText: '',
        responseTimeMs,
      }),
    });

    // Track skip in session stats (quality = 0)
    setSessionStats((prev) => {
      const newQualities = [...prev.qualities, 0];
      const avg = newQualities.reduce((s, q) => s + q, 0) / newQualities.length;
      return {
        activitiesCompleted: prev.activitiesCompleted + 1,
        avgQuality: avg,
        totalTimeMs: Date.now() - sessionStartTime.current,
        qualities: newQualities,
      };
    });

    advanceToNext();
  }

  function advanceToNext() {
    const nextIndex = currentIndex + 1;
    if (nextIndex >= flatActivities.length) {
      // End of session → post_session
      setCompleteStats(sessionStats);
      setPhase('post_session');
    } else {
      setCurrentIndex(nextIndex);
      setResponseText('');
      setSubmitted(false);
      setSelectedQuality(null);
      setLastResult(null);
      activityStartTime.current = Date.now();
    }
  }

  // ---------------------------------------------------------------------------
  // POST_SESSION: reflect + complete
  // ---------------------------------------------------------------------------

  async function handleCompleteSession() {
    if (!sessionId) return;
    setReflectLoading(true);
    try {
      const res = await fetch(`/api/study/session/${sessionId}/reflect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reflection }),
      });
      const data = (await res.json()) as { calibrationScore?: number; activitiesCompleted?: number };
      setFinalCalibrationScore(data.calibrationScore ?? null);
      setCompleteStats(sessionStats);
      setPhase('complete');
    } finally {
      setReflectLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render: LOADING
  // ---------------------------------------------------------------------------

  if (phase === 'loading') {
    if (loadError) {
      return (
        <div className="max-w-2xl mx-auto py-20 text-center">
          <p className="text-sm text-red-400">Error: {loadError}</p>
          <a href="/study" className="mt-4 inline-block text-sm text-blue-400 hover:text-blue-300">
            Back to Study
          </a>
        </div>
      );
    }

    if (sessionData && sessionData.totalActivities === 0) {
      return (
        <div className="max-w-2xl mx-auto py-20 text-center">
          <p className="text-xl font-medium text-gray-300 mb-2">Nothing to study today</p>
          <p className="text-sm text-gray-500 mb-6">All activities are up to date. Check back tomorrow.</p>
          <a
            href="/study"
            className="px-5 py-2.5 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors"
          >
            Back to Study
          </a>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-gray-500">Loading session...</p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: PRE_SESSION
  // ---------------------------------------------------------------------------

  if (phase === 'pre_session' && sessionData) {
    const concepts = getUniqueConceptsFromBlocks(sessionData.blocks);

    return (
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-xl font-semibold text-gray-100 mb-1">Today&apos;s Session</h2>
          <p className="text-sm text-gray-500">
            {sessionData.totalActivities} activities · ~{sessionData.estimatedMinutes}min
          </p>
        </div>

        {/* Confidence ratings */}
        <div className="space-y-3">
          <p className="text-sm text-gray-400">
            How confident are you with these topics?
          </p>
          {concepts.map(({ conceptId, conceptTitle, domain }) => (
            <div
              key={conceptId}
              className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3"
            >
              <div>
                <p className="font-medium text-gray-100">{conceptTitle}</p>
                {domain && <p className="text-xs text-gray-500 mt-0.5">{domain}</p>}
              </div>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setPreConfidence((prev) => ({ ...prev, [conceptId]: n }))}
                    className={`flex-1 py-1.5 rounded-full text-sm font-medium transition-colors ${
                      preConfidence[conceptId] === n
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Begin button */}
        <button
          onClick={handleBeginSession}
          className="w-full py-3 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          Begin Session
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: IN_PROGRESS
  // ---------------------------------------------------------------------------

  if (phase === 'in_progress' && flatActivities.length > 0) {
    const total = flatActivities.length;
    const current = flatActivities[currentIndex];
    const activity = current.activity;
    const progressPct = ((currentIndex) / total) * 100;

    // Detect block boundary
    const isFirstInBlock =
      currentIndex === 0 ||
      flatActivities[currentIndex - 1].blockIndex !== current.blockIndex;

    const isCardReview = activity.activityType === 'card_review';

    return (
      <div className="max-w-2xl mx-auto space-y-4">
        {/* Progress bar */}
        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{currentIndex + 1} / {total}</span>
            <span className="text-gray-600">~{Math.ceil(sessionData?.estimatedMinutes ?? 0)} min</span>
          </div>
          <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* Block label */}
        {isFirstInBlock && (
          <div className="flex items-center gap-3 pt-1">
            <div className="flex-1 h-px bg-gray-800" />
            <span className="text-xs text-gray-500 uppercase tracking-wider font-medium">
              {BLOCK_LABELS[current.blockType] ?? current.blockType}
            </span>
            <div className="flex-1 h-px bg-gray-800" />
          </div>
        )}

        {/* Activity card */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
          {/* Concept + domain */}
          <div>
            <p className="font-semibold text-gray-100">{activity.conceptTitle}</p>
            {activity.domain && (
              <p className="text-xs text-gray-500 mt-0.5">{activity.domain}</p>
            )}
          </div>

          {/* Badges */}
          <div className="flex gap-2 flex-wrap">
            <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">
              {BLOOM_LABELS[activity.bloomLevel] ?? `L${activity.bloomLevel}`}
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">
              {ACTIVITY_TYPE_LABELS[activity.activityType] ?? activity.activityType}
            </span>
          </div>

          {/* Prompt */}
          <p className="text-gray-100 text-base leading-relaxed">{activity.prompt}</p>

          {/* Response area (pre-submission) */}
          {!submitted && (
            <div className="space-y-3">
              {isCardReview ? (
                <input
                  type="text"
                  value={responseText}
                  onChange={(e) => setResponseText(e.target.value)}
                  placeholder="Your answer..."
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSubmit();
                  }}
                />
              ) : (
                <textarea
                  value={responseText}
                  onChange={(e) => setResponseText(e.target.value)}
                  placeholder="Write your response..."
                  rows={4}
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 resize-none focus:outline-none focus:border-gray-500"
                />
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleSubmit}
                  className="flex-1 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                >
                  Submit
                </button>
                <button
                  onClick={handleSkip}
                  className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-300 bg-gray-800 hover:bg-gray-700 transition-colors"
                >
                  Skip
                </button>
              </div>
            </div>
          )}

          {/* Post-submission: reference answer + self-rating */}
          {submitted && (
            <div className="space-y-4">
              {/* Reference answer */}
              {activity.referenceAnswer && (
                <div className="border-t border-gray-700 bg-gray-800 mt-4 p-4 rounded-lg">
                  <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Reference Answer</p>
                  <p className="text-sm text-gray-200 leading-relaxed">{activity.referenceAnswer}</p>
                </div>
              )}

              {/* Advancement notice */}
              {lastResult?.advancement && (
                <div className="bg-blue-950/40 border border-blue-800 rounded-lg p-3">
                  <p className="text-sm text-blue-300">
                    Bloom level advanced: L{lastResult.advancement.previousCeiling} → L{lastResult.advancement.newCeiling} for &quot;{lastResult.advancement.conceptTitle}&quot;
                  </p>
                </div>
              )}

              {/* De-escalation hint */}
              {lastResult?.deEscalation && (
                <div className="bg-amber-950/30 border border-amber-800/50 rounded-lg p-3">
                  <p className="text-sm text-amber-300">{lastResult.deEscalation}</p>
                </div>
              )}

              {/* Self-rating */}
              {selectedQuality === null ? (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500 uppercase tracking-wider">Rate your recall</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {([0, 1, 2, 3, 4, 5] as const).map((q) => (
                      <button
                        key={q}
                        onClick={() => handleQualityRating(q)}
                        className="flex-1 min-w-0 py-2 rounded-full text-xs font-medium bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-gray-100 transition-colors"
                      >
                        {q}: {QUALITY_LABELS[q]}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-400">
                    Rated <span className="text-blue-400 font-medium">{selectedQuality}</span> — {QUALITY_LABELS[selectedQuality]}
                  </p>
                  <button
                    onClick={advanceToNext}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: POST_SESSION
  // ---------------------------------------------------------------------------

  if (phase === 'post_session' && sessionData) {
    const concepts = getUniqueConceptsFromBlocks(sessionData.blocks);

    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-gray-100 mb-1">Session Summary</h2>
          <p className="text-sm text-gray-500">
            {sessionStats.activitiesCompleted} activities · avg quality {sessionStats.avgQuality.toFixed(1)}/5
            {sessionStats.totalTimeMs > 0 && ` · ${formatTime(sessionStats.totalTimeMs)}`}
          </p>
        </div>

        {/* Calibration feedback */}
        {Object.keys(preConfidence).length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <p className="text-sm font-medium text-gray-300 uppercase tracking-wider">Calibration</p>
            {concepts.map(({ conceptId, conceptTitle }) => {
              const predicted = preConfidence[conceptId];
              if (predicted === undefined) return null;

              // Compute actual avg quality for this concept
              // Map each activity to its quality by original index, then filter to this concept
              const logs = flatActivities
                .map((fa, idx) => ({ cid: fa.activity.conceptId, quality: sessionStats.qualities[idx] }))
                .filter((entry) => entry.cid === conceptId && entry.quality !== undefined)
                .map((entry) => entry.quality as number);

              const actualAvg =
                logs.length > 0
                  ? logs.reduce((s, q) => s + q, 0) / logs.length
                  : null;

              const actualNorm = actualAvg !== null ? actualAvg / 5 : null;
              const predictedNorm = predicted / 5;

              return (
                <div key={conceptId} className="flex items-center justify-between py-1">
                  <span className="text-sm text-gray-300">{conceptTitle}</span>
                  {actualNorm !== null ? (
                    <span className={`text-sm font-medium ${calibrationColor(predictedNorm, actualNorm)}`}>
                      Predicted {predicted}/5 · Scored {(actualNorm * 5).toFixed(1)}/5
                    </span>
                  ) : (
                    <span className="text-sm text-gray-600">Predicted {predicted}/5 · No data</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Reflection */}
        <div className="space-y-2">
          <label className="text-sm text-gray-400">
            What did you find surprising or difficult?
          </label>
          <textarea
            value={reflection}
            onChange={(e) => setReflection(e.target.value)}
            rows={4}
            placeholder="Optional reflection..."
            className="w-full bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-600 resize-none focus:outline-none focus:border-gray-700"
          />
        </div>

        <button
          onClick={handleCompleteSession}
          disabled={reflectLoading}
          className="w-full py-3 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
        >
          {reflectLoading ? 'Saving...' : 'Complete Session'}
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: COMPLETE
  // ---------------------------------------------------------------------------

  if (phase === 'complete') {
    const stats = completeStats;
    return (
      <div className="max-w-2xl mx-auto py-10 text-center space-y-6">
        <div>
          <p className="text-3xl font-semibold text-gray-100 mb-2">Session complete!</p>
          <p className="text-sm text-gray-500">Great work. Here&apos;s your summary.</p>
        </div>

        {stats && (
          <div className="flex justify-center gap-12">
            <div>
              <p className="text-3xl font-mono text-blue-400">{stats.activitiesCompleted}</p>
              <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Activities</p>
            </div>
            <div>
              <p className="text-3xl font-mono text-blue-400">{stats.avgQuality.toFixed(1)}</p>
              <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Avg Quality</p>
            </div>
            {stats.totalTimeMs > 0 && (
              <div>
                <p className="text-3xl font-mono text-blue-400">{formatTime(stats.totalTimeMs)}</p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Time</p>
              </div>
            )}
            {finalCalibrationScore !== null && (
              <div>
                <p className="text-3xl font-mono text-blue-400">
                  {Math.round(finalCalibrationScore * 100)}%
                </p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Calibration</p>
              </div>
            )}
          </div>
        )}

        <a
          href="/study"
          className="inline-block px-6 py-2.5 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors"
        >
          Back to Study
        </a>
      </div>
    );
  }

  // Fallback (shouldn't reach)
  return null;
}
