'use client';

import { Suspense } from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';

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
  sourceNotePath: string | null;
  generatedAt: string;
  staleReason?: string;
  scaffoldingLevel: number;
  hint: string | null;
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

interface PrerequisiteWarning {
  conceptId: string;
  conceptTitle: string;
  weakPrerequisites: Array<{
    id: string;
    title: string;
    masteryOverall: number;
  }>;
}

interface StalenessWarning {
  activityId: string;
  staleReason: 'source_deleted' | 'source_modified';
}

interface SessionWarnings {
  prerequisites: PrerequisiteWarning[];
  staleActivities: StalenessWarning[];
}

type Phase = 'loading' | 'pre_session' | 'in_progress' | 'post_session' | 'complete';

type EvaluationMode = 'choosing' | 'evaluating' | 'result' | 'self_rate' | null;

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

/** Returns number of textarea rows for a given activity type */
function textAreaRows(activityType: string): number {
  switch (activityType) {
    case 'synthesis':
      return 10;
    case 'concept_map':
      return 8;
    case 'self_explain':
    case 'comparison':
    case 'case_analysis':
      return 6;
    default:
      return 4;
  }
}

/** Whether AI evaluation is eligible for this activity */
function isAiEvalEligible(bloomLevel: number, activityType: string): boolean {
  return bloomLevel >= 3 && activityType !== 'card_review';
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

function StudySessionInner() {
  const searchParams = useSearchParams();
  const planId = searchParams.get('planId');

  const [phase, setPhase] = useState<Phase>('loading');
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [planTitle, setPlanTitle] = useState<string | null>(null);

  // Warnings
  const [warnings, setWarnings] = useState<SessionWarnings>({ prerequisites: [], staleActivities: [] });
  const [prereqWarningDismissed, setPrereqWarningDismissed] = useState(false);

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

  // AI Evaluation state
  const [evaluationMode, setEvaluationMode] = useState<EvaluationMode>(null);
  const [aiFeedback, setAiFeedback] = useState<string>('');
  const [aiQuality, setAiQuality] = useState<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const evalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const evalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hint display
  const [showHint, setShowHint] = useState(false);

  // Suggestion prompt (student-generated activities)
  const [showSuggestionPrompt, setShowSuggestionPrompt] = useState(false);
  const [showSuggestionForm, setShowSuggestionForm] = useState(false);
  const [suggestionSubmitting, setSuggestionSubmitting] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [suggestionSuccess, setSuggestionSuccess] = useState(false);
  const [suggestionActivityType, setSuggestionActivityType] = useState('card_review');
  const [suggestionPromptText, setSuggestionPromptText] = useState('');
  const [suggestionBloomLevel, setSuggestionBloomLevel] = useState(1);

  // POST_SESSION
  const [reflection, setReflection] = useState('');
  const [reflectLoading, setReflectLoading] = useState(false);
  const [finalCalibrationScore, setFinalCalibrationScore] = useState<number | null>(null);

  // COMPLETE — store final stats snapshot
  const [completeStats, setCompleteStats] = useState<SessionStats | null>(null);

  // ---------------------------------------------------------------------------
  // Cleanup helpers for AI eval
  // ---------------------------------------------------------------------------

  const cleanupEvalResources = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (evalPollRef.current) {
      clearInterval(evalPollRef.current);
      evalPollRef.current = null;
    }
    if (evalTimeoutRef.current) {
      clearTimeout(evalTimeoutRef.current);
      evalTimeoutRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupEvalResources();
    };
  }, [cleanupEvalResources]);

  // ---------------------------------------------------------------------------
  // Fetch plan title when planId is present
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (planId) {
      fetch(`/api/study/plans/${planId}`)
        .then((r) => r.json())
        .then((data: { plan?: { title?: string } }) => setPlanTitle(data.plan?.title ?? null))
        .catch(() => {});
    }
  }, [planId]);

  // ---------------------------------------------------------------------------
  // LOADING: fetch session data
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (phase !== 'loading') return;
    const url = planId ? `/api/study/session?planId=${planId}` : '/api/study/session';
    fetch(url)
      .then((r) => r.json())
      .then((data: { session?: SessionData; warnings?: SessionWarnings; error?: string }) => {
        if (data.error) {
          setLoadError(data.error);
          return;
        }
        const session = data.session;
        if (!session || session.totalActivities === 0) {
          // No activities — stay on loading phase but show empty state
          setSessionData({ blocks: [], totalActivities: 0, estimatedMinutes: 0, domainsCovered: [] });
        } else {
          // Apply staleReason to activities from warnings
          const sessionWarnings = data.warnings ?? { prerequisites: [], staleActivities: [] };
          const staleMap = new Map(
            sessionWarnings.staleActivities.map((w) => [w.activityId, w.staleReason]),
          );
          const sessionWithStale: SessionData = {
            ...session,
            blocks: session.blocks.map((block) => ({
              ...block,
              activities: block.activities.map((a) => ({
                ...a,
                staleReason: staleMap.get(a.activityId),
              })),
            })),
          };
          setSessionData(sessionWithStale);
          setWarnings(sessionWarnings);
          setPhase('pre_session');
        }
      })
      .catch((err: unknown) => {
        setLoadError(String(err));
      });
  }, [phase, planId]);

  // ---------------------------------------------------------------------------
  // PRE_SESSION: begin session
  // ---------------------------------------------------------------------------

  async function handleBeginSession() {
    if (!sessionData) return;
    const res = await fetch('/api/study/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionType: 'daily',
        preConfidence,
        planId: planId || undefined,
      }),
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
    setEvaluationMode(null);
    setAiFeedback('');
    setAiQuality(null);
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

    const flat = flatActivities[currentIndex];
    if (!flat) return;
    const { bloomLevel, activityType } = flat.activity;

    if (isAiEvalEligible(bloomLevel, activityType)) {
      setEvaluationMode('choosing');
    }
    // else evaluationMode stays null → existing self-rate flow
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
        scaffoldingLevel: flat.activity.scaffoldingLevel ?? 0,
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

    // Show suggestion prompt for struggle (0-2) or mastery (5)
    if (quality <= 2 || quality === 5) {
      setSuggestionBloomLevel(flat.activity.bloomLevel);
      setSuggestionActivityType('card_review');
      setSuggestionPromptText('');
      setShowSuggestionPrompt(true);
    }
  }

  async function handleSuggestionSubmit() {
    const flat = flatActivities[currentIndex];
    if (!flat) return;
    setSuggestionSubmitting(true);
    try {
      await fetch('/api/study/suggest-activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conceptId: flat.activity.conceptId,
          activityType: suggestionActivityType,
          prompt: suggestionPromptText,
          bloomLevel: suggestionBloomLevel,
        }),
      });
      setSuggestionSuccess(true);
      setShowSuggestionForm(false);
    } finally {
      setSuggestionSubmitting(false);
    }
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
        scaffoldingLevel: flat.activity.scaffoldingLevel ?? 0,
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
    cleanupEvalResources();
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
      setEvaluationMode(null);
      setAiFeedback('');
      setAiQuality(null);
      setShowSuggestionPrompt(false);
      setShowSuggestionForm(false);
      setSuggestionDismissed(false);
      setSuggestionSuccess(false);
      setSuggestionPromptText('');
      setShowHint(false);
      activityStartTime.current = Date.now();
    }
  }

  // ---------------------------------------------------------------------------
  // AI Evaluation flow
  // ---------------------------------------------------------------------------

  async function handleAiEvaluate() {
    if (!sessionId) return;
    const flat = flatActivities[currentIndex];
    if (!flat) return;
    const { activityId, conceptId, bloomLevel, prompt, referenceAnswer } = flat.activity;

    cleanupEvalResources();
    setEvaluationMode('evaluating');
    setAiFeedback('');
    setAiQuality(null);

    // Open SSE stream
    const es = new EventSource(`/api/study/chat/stream/${sessionId}`);
    eventSourceRef.current = es;

    es.addEventListener('message', (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data as string) as { type?: string; text?: string };
        if (parsed.type === 'message' && parsed.text) {
          setAiFeedback((prev) => prev + parsed.text);
        }
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener('error', () => {
      // SSE errors are non-fatal — polling will still resolve the result
    });

    // Send evaluation request
    try {
      await fetch('/api/study/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          activityId,
          responseText,
          conceptId,
          bloomLevel,
          prompt,
          referenceAnswer,
        }),
      });
    } catch {
      // If request fails, fall back
      setEvaluationMode('self_rate');
      cleanupEvalResources();
      return;
    }

    // Poll for result every 2s
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/study/evaluate/${sessionId}/result?activityId=${encodeURIComponent(activityId)}`,
        );
        const data = (await res.json()) as { status?: string; quality?: number; aiFeedback?: string };
        if (data.status === 'complete') {
          clearInterval(pollInterval);
          evalPollRef.current = null;
          clearTimeout(evalTimeoutRef.current!);
          evalTimeoutRef.current = null;
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          if (data.quality !== undefined) setAiQuality(data.quality);
          if (data.aiFeedback) setAiFeedback(data.aiFeedback);

          // Accumulate stats using the AI-reported quality (or 3 as a neutral fallback)
          const quality = data.quality ?? 3;
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

          setEvaluationMode('result');
        }
      } catch {
        // ignore transient polling errors
      }
    }, 2000);
    evalPollRef.current = pollInterval;

    // Timeout after 60s → fall back to self-rate
    const timeout = setTimeout(() => {
      cleanupEvalResources();
      setEvaluationMode('self_rate');
    }, 60_000);
    evalTimeoutRef.current = timeout;
  }

  function handleChooseSelfRate() {
    setEvaluationMode('self_rate');
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
        {/* Plan context banner */}
        {planTitle && (
          <div className="bg-blue-900/30 border border-blue-800 rounded-lg px-4 py-2 flex items-center justify-between">
            <span className="text-blue-300 text-sm">
              Studying: <span className="font-medium text-blue-200">{planTitle}</span>
            </span>
            <a href="/study/plan" className="text-blue-400 hover:text-blue-300 text-sm">
              &larr; Back to plan
            </a>
          </div>
        )}

        {/* Prerequisite warning banner */}
        {!prereqWarningDismissed && warnings.prerequisites.length > 0 && (
          <div className="rounded-lg border border-amber-800/50 bg-amber-900/20 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1.5 flex-1">
                <div className="flex items-center gap-2">
                  <svg className="h-4 w-4 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <span className="text-sm font-medium text-amber-300">Prerequisite gaps detected</span>
                </div>
                {warnings.prerequisites.map((w) =>
                  w.weakPrerequisites.map((prereq) => (
                    <p key={`${w.conceptId}-${prereq.id}`} className="text-sm text-amber-200/80 ml-6">
                      <span className="font-medium">{w.conceptTitle}</span> depends on{' '}
                      <span className="font-medium">{prereq.title}</span>{' '}
                      <span className="text-amber-400">(mastery: {Math.round(prereq.masteryOverall * 100)}%)</span>
                      {' '}— consider reviewing first
                    </p>
                  )),
                )}
              </div>
              <button
                onClick={() => setPrereqWarningDismissed(true)}
                className="text-amber-500 hover:text-amber-300 transition-colors shrink-0 mt-0.5"
                aria-label="Dismiss warning"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

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
    const isSocratic = activity.activityType === 'socratic';
    const aiEligible = isAiEvalEligible(activity.bloomLevel, activity.activityType);

    return (
      <div className="max-w-2xl mx-auto space-y-4">
        {/* Plan context banner */}
        {planTitle && (
          <div className="bg-blue-900/30 border border-blue-800 rounded-lg px-4 py-2 flex items-center justify-between">
            <span className="text-blue-300 text-sm">
              Studying: <span className="font-medium text-blue-200">{planTitle}</span>
            </span>
            <a href="/study/plan" className="text-blue-400 hover:text-blue-300 text-sm">
              &larr; Back to plan
            </a>
          </div>
        )}

        {/* Prerequisite warning banner */}
        {!prereqWarningDismissed && warnings.prerequisites.length > 0 && (
          <div className="rounded-lg border border-amber-800/50 bg-amber-900/20 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1.5 flex-1">
                <div className="flex items-center gap-2">
                  <svg className="h-4 w-4 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <span className="text-sm font-medium text-amber-300">Prerequisite gaps detected</span>
                </div>
                {warnings.prerequisites.map((w) =>
                  w.weakPrerequisites.map((prereq) => (
                    <p key={`${w.conceptId}-${prereq.id}`} className="text-sm text-amber-200/80 ml-6">
                      <span className="font-medium">{w.conceptTitle}</span> depends on{' '}
                      <span className="font-medium">{prereq.title}</span>{' '}
                      <span className="text-amber-400">(mastery: {Math.round(prereq.masteryOverall * 100)}%)</span>
                      {' '}— consider reviewing first
                    </p>
                  )),
                )}
              </div>
              <button
                onClick={() => setPrereqWarningDismissed(true)}
                className="text-amber-500 hover:text-amber-300 transition-colors shrink-0 mt-0.5"
                aria-label="Dismiss warning"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

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
            {activity.staleReason === 'source_deleted' && (
              <span className="text-xs px-2 py-0.5 rounded bg-amber-900/50 text-amber-400">
                Source deleted
              </span>
            )}
            {activity.staleReason === 'source_modified' && (
              <span className="text-xs px-2 py-0.5 rounded bg-amber-900/50 text-amber-400">
                Source updated
              </span>
            )}
          </div>

          {/* Prompt */}
          <p className="text-gray-100 text-base leading-relaxed">{activity.prompt}</p>

          {/* Scaffolding hint */}
          {activity.scaffoldingLevel >= 1 && activity.hint && !submitted && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowHint((v) => !v)}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  {showHint ? 'Hide hint' : 'Need a hint?'}
                </button>
                <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-400">
                  L{activity.scaffoldingLevel}
                </span>
              </div>
              {showHint && (
                <p className="mt-2 p-3 rounded-lg bg-gray-800/50 text-sm text-gray-300 italic">
                  {activity.hint}
                </p>
              )}
            </div>
          )}

          {/* Socratic: redirect instead of in-session activity */}
          {isSocratic ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-400">
                This activity is best completed as a dialogue.
              </p>
              <div className="flex gap-2">
                <a
                  href={`/study/chat?conceptId=${encodeURIComponent(activity.conceptId)}&method=Socratic`}
                  className="flex-1 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors text-center"
                >
                  Open in Study Chat
                </a>
                <button
                  onClick={handleSkip}
                  className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-300 bg-gray-800 hover:bg-gray-700 transition-colors"
                >
                  Skip
                </button>
              </div>
            </div>
          ) : (
            <>
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
                      rows={textAreaRows(activity.activityType)}
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

              {/* Post-submission area */}
              {submitted && (
                <div className="space-y-4">

                  {/* ---- EVALUATION MODE: choosing ---- */}
                  {evaluationMode === 'choosing' && (
                    <div className="space-y-3">
                      <p className="text-xs text-gray-500 uppercase tracking-wider">How would you like to evaluate?</p>
                      <div className="flex gap-2">
                        <button
                          onClick={handleAiEvaluate}
                          className="flex-1 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                        >
                          AI Evaluate
                        </button>
                        <button
                          onClick={handleChooseSelfRate}
                          className="flex-1 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
                        >
                          Self-Rate
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ---- EVALUATION MODE: evaluating (AI in progress) ---- */}
                  {evaluationMode === 'evaluating' && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm text-gray-400">
                        <svg className="animate-spin h-4 w-4 text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span>AI is evaluating your response...</span>
                      </div>
                      {aiFeedback && (
                        <div className="bg-gray-800 rounded-lg p-3">
                          <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{aiFeedback}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ---- EVALUATION MODE: result (AI done) ---- */}
                  {evaluationMode === 'result' && (
                    <div className="space-y-3">
                      {aiQuality !== null && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500 uppercase tracking-wider">AI Score</span>
                          <span className="px-2 py-0.5 rounded-full bg-indigo-900/60 border border-indigo-700 text-indigo-300 text-sm font-medium">
                            {aiQuality} / 5
                          </span>
                        </div>
                      )}
                      {aiFeedback && (
                        <div className="bg-gray-800 rounded-lg p-3">
                          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1.5">AI Feedback</p>
                          <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{aiFeedback}</p>
                        </div>
                      )}
                      <div className="flex justify-end">
                        <button
                          onClick={advanceToNext}
                          className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ---- EVALUATION MODE: self_rate (chosen or timeout fallback) ---- */}
                  {(evaluationMode === 'self_rate' || (!aiEligible && evaluationMode === null)) && (
                    <>
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

                      {/* Self-rating buttons */}
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
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <p className="text-sm text-gray-400">
                              Rated <span className="text-blue-400 font-medium">{selectedQuality}</span> — {QUALITY_LABELS[selectedQuality]}
                            </p>
                            {(!showSuggestionPrompt || suggestionDismissed || suggestionSuccess) && (
                              <button
                                onClick={advanceToNext}
                                className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                              >
                                Next
                              </button>
                            )}
                          </div>

                          {/* Suggestion prompt */}
                          {showSuggestionPrompt && !suggestionDismissed && !suggestionSuccess && !showSuggestionForm && (
                            <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-2">
                              <p className="text-sm text-gray-300">
                                {selectedQuality !== null && selectedQuality <= 2
                                  ? `This was a tough one. Want to create your own question about "${activity.conceptTitle}" to practice later?`
                                  : `Great work! Want to capture what made this click as a study question?`}
                              </p>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => setShowSuggestionForm(true)}
                                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                                >
                                  Yes, create one
                                </button>
                                <button
                                  onClick={() => setSuggestionDismissed(true)}
                                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
                                >
                                  No thanks
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Suggestion form */}
                          {showSuggestionForm && !suggestionSuccess && (
                            <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 space-y-3">
                              <p className="text-xs text-gray-500 uppercase tracking-wider">Create a study question</p>

                              <div className="space-y-1">
                                <label className="text-xs text-gray-400">Activity type</label>
                                <select
                                  value={suggestionActivityType}
                                  onChange={(e) => setSuggestionActivityType(e.target.value)}
                                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-500"
                                >
                                  <option value="card_review">Card Review</option>
                                  <option value="elaboration">Elaboration</option>
                                  <option value="self_explain">Self Explain</option>
                                  <option value="comparison">Comparison</option>
                                </select>
                              </div>

                              <div className="space-y-1">
                                <label className="text-xs text-gray-400">Your study question</label>
                                <textarea
                                  value={suggestionPromptText}
                                  onChange={(e) => setSuggestionPromptText(e.target.value)}
                                  placeholder="Your study question..."
                                  rows={3}
                                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 resize-none focus:outline-none focus:border-gray-500"
                                />
                              </div>

                              <div className="space-y-1">
                                <label className="text-xs text-gray-400">Bloom&apos;s level</label>
                                <div className="flex gap-1.5">
                                  {([1, 2, 3, 4, 5, 6] as const).map((lvl) => (
                                    <button
                                      key={lvl}
                                      onClick={() => setSuggestionBloomLevel(lvl)}
                                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                        suggestionBloomLevel === lvl
                                          ? 'bg-blue-600 text-white'
                                          : 'bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-gray-200'
                                      }`}
                                    >
                                      L{lvl}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              <div className="flex gap-2 pt-1">
                                <button
                                  onClick={handleSuggestionSubmit}
                                  disabled={suggestionSubmitting || !suggestionPromptText.trim()}
                                  className="flex-1 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
                                >
                                  {suggestionSubmitting ? 'Saving...' : 'Submit'}
                                </button>
                                <button
                                  onClick={() => { setShowSuggestionForm(false); setSuggestionDismissed(true); }}
                                  className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-300 bg-gray-700 hover:bg-gray-600 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Success message */}
                          {suggestionSuccess && (
                            <div className="flex items-center justify-between">
                              <p className="text-sm text-green-400">Activity created!</p>
                              <button
                                onClick={advanceToNext}
                                className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                              >
                                Next
                              </button>
                            </div>
                          )}

                          {/* Next button when suggestion was dismissed */}
                          {suggestionDismissed && (
                            <div className="flex justify-end">
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
                    </>
                  )}

                  {/* ---- evaluationMode === null && aiEligible: choosing not yet shown
                       This shouldn't happen — handleSubmit sets choosing immediately.
                       Guard for completeness only. ---- */}

                </div>
              )}
            </>
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

export default function StudySessionPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-gray-500">Loading session...</p>
      </div>
    }>
      <StudySessionInner />
    </Suspense>
  );
}
