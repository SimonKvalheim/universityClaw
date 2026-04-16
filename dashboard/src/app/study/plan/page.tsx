'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { ConceptSummary } from '@/lib/study-db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlanSummary {
  id: string;
  title: string;
  domain: string | null;
  course: string | null;
  strategy: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  nextCheckpointAt: string | null;
  conceptCount: number;
  progressPercent: number;
}

interface PlanConceptDetail {
  conceptId: string;
  title: string;
  domain: string | null;
  bloomCeiling: number;
  targetBloom: number;
  masteryOverall: number;
  atTarget: boolean;
}

interface PlanDetail extends PlanSummary {
  learningObjectives: string | null;
  desiredOutcomes: string | null;
  implementationIntention: string | null;
  obstacle: string | null;
  studySchedule: string | null;
  config: string | null;
  checkpointIntervalDays: number;
  concepts: PlanConceptDetail[];
}

type View = 'list' | 'create' | 'detail';

type Strategy = 'open' | 'exam-prep' | 'weekly-review' | 'exploration';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STRATEGY_OPTIONS: Array<{ value: Strategy; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'exam-prep', label: 'Exam Prep' },
  { value: 'weekly-review', label: 'Weekly Review' },
  { value: 'exploration', label: 'Exploration' },
];

const STRATEGY_BADGE: Record<string, string> = {
  open: 'bg-blue-900 text-blue-300',
  'exam-prep': 'bg-red-900 text-red-300',
  'weekly-review': 'bg-purple-900 text-purple-300',
  exploration: 'bg-amber-900 text-amber-300',
};

const BLOOM_LABELS: Record<number, string> = {
  1: 'L1 Remember',
  2: 'L2 Understand',
  3: 'L3 Apply',
  4: 'L4 Analyse',
  5: 'L5 Evaluate',
  6: 'L6 Create',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StrategyBadge({ strategy }: { strategy: string }) {
  const cls = STRATEGY_BADGE[strategy] ?? 'bg-gray-800 text-gray-400';
  const label = STRATEGY_OPTIONS.find((s) => s.value === strategy)?.label ?? strategy;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
      <div
        className="h-full bg-green-500 rounded-full transition-all duration-300"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Concept selector sub-component
// ---------------------------------------------------------------------------

interface ConceptSelectorProps {
  allConcepts: ConceptSummary[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: (ids: string[]) => void;
  excludeIds?: Set<string>;
}

function ConceptSelector({ allConcepts, selected, onToggle, onSelectAll, excludeIds }: ConceptSelectorProps) {
  const filtered = excludeIds
    ? allConcepts.filter((c) => !excludeIds.has(c.id))
    : allConcepts;

  // Group by domain
  const domainMap = new Map<string, ConceptSummary[]>();
  for (const c of filtered) {
    const key = c.domain ?? 'Uncategorised';
    if (!domainMap.has(key)) domainMap.set(key, []);
    domainMap.get(key)!.push(c);
  }

  if (filtered.length === 0) {
    return <p className="text-sm text-gray-500">No concepts available.</p>;
  }

  return (
    <div className="space-y-4">
      {Array.from(domainMap.entries()).map(([domain, concepts]) => {
        const domainIds = concepts.map((c) => c.id);
        const allSelected = domainIds.every((id) => selected.has(id));
        return (
          <div key={domain} className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">{domain}</span>
              <button
                type="button"
                onClick={() => onSelectAll(allSelected ? [] : domainIds)}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {concepts.map((c) => (
                <label
                  key={c.id}
                  className={`flex items-center gap-1.5 cursor-pointer text-xs px-2.5 py-1.5 rounded-md border transition-colors ${
                    selected.has(c.id)
                      ? 'bg-blue-900/40 border-blue-700 text-blue-200'
                      : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => onToggle(c.id)}
                    className="w-3 h-3 accent-blue-500"
                  />
                  {c.title}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function StudyPlanPage() {
  const router = useRouter();
  const [view, setView] = useState<View>('list');
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<PlanDetail | null>(null);
  const [allConcepts, setAllConcepts] = useState<ConceptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  // Create form state
  const [createTitle, setCreateTitle] = useState('');
  const [createStrategy, setCreateStrategy] = useState<Strategy>('open');
  const [createExamDate, setCreateExamDate] = useState('');
  const [createSelectedConcepts, setCreateSelectedConcepts] = useState<Set<string>>(new Set());
  const [createTargetBloom, setCreateTargetBloom] = useState(6);
  const [createLearningObjectives, setCreateLearningObjectives] = useState('');
  const [createDesiredOutcomes, setCreateDesiredOutcomes] = useState('');
  const [createStudySchedule, setCreateStudySchedule] = useState('');
  const [createImplementationIntention, setCreateImplementationIntention] = useState('');
  const [createObstacle, setCreateObstacle] = useState('');
  const [createCheckpointDays, setCreateCheckpointDays] = useState(14);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Add concepts panel (detail view)
  const [showAddConcepts, setShowAddConcepts] = useState(false);
  const [addConceptsSelected, setAddConceptsSelected] = useState<Set<string>>(new Set());
  const [addConceptsSubmitting, setAddConceptsSubmitting] = useState(false);

  // ---------------------------------------------------------------------------
  // Fetch helpers
  // ---------------------------------------------------------------------------

  const fetchPlans = useCallback(async () => {
    try {
      const res = await fetch('/api/study/plans');
      const data = (await res.json()) as { plans: PlanSummary[] };
      setPlans(data.plans ?? []);
    } catch {
      // silently fail
    }
  }, []);

  const fetchConcepts = useCallback(async () => {
    try {
      const res = await fetch('/api/study/concepts');
      const data = (await res.json()) as { concepts: ConceptSummary[] };
      setAllConcepts(data.concepts ?? []);
    } catch {
      // silently fail
    }
  }, []);

  const fetchPlanDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/study/plans/${id}`);
      const data = (await res.json()) as { plan: PlanDetail };
      setSelectedPlan(data.plan ?? null);
    } catch {
      // silently fail
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchPlans(), fetchConcepts()]).finally(() => setLoading(false));
  }, [fetchPlans, fetchConcepts]);

  // ---------------------------------------------------------------------------
  // Handlers: navigation
  // ---------------------------------------------------------------------------

  function goToList() {
    setView('list');
    setSelectedPlan(null);
    setShowAddConcepts(false);
    setAddConceptsSelected(new Set());
  }

  function goToCreate() {
    setCreateTitle('');
    setCreateStrategy('open');
    setCreateExamDate('');
    setCreateSelectedConcepts(new Set());
    setCreateTargetBloom(6);
    setCreateLearningObjectives('');
    setCreateDesiredOutcomes('');
    setCreateStudySchedule('');
    setCreateImplementationIntention('');
    setCreateObstacle('');
    setCreateCheckpointDays(14);
    setShowAdvanced(false);
    setCreateError(null);
    setView('create');
  }

  async function goToDetail(plan: PlanSummary) {
    setView('detail');
    await fetchPlanDetail(plan.id);
  }

  // ---------------------------------------------------------------------------
  // Handlers: concept toggle helpers
  // ---------------------------------------------------------------------------

  function toggleCreateConcept(id: string) {
    setCreateSelectedConcepts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllCreateDomain(ids: string[]) {
    if (ids.length === 0) {
      // Deselect all in domain — we'd need to know which domain; caller passes empty for deselect
      // The selector passes [] when deselecting, but we need the domain ids — handled below
      return;
    }
    setCreateSelectedConcepts((prev) => {
      const next = new Set(prev);
      // ids is the full domain list; if all selected, caller passed []
      ids.forEach((id) => next.add(id));
      return next;
    });
  }

  function deselectAllCreateDomain(ids: string[]) {
    setCreateSelectedConcepts((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  }

  function handleCreateSelectAll(ids: string[]) {
    if (ids.length === 0) {
      // Caller signals deselect (passes empty). We need the domain ids from the toggle.
      // Since ConceptSelector passes all domain ids when deselecting, this is fine.
      return;
    }
    selectAllCreateDomain(ids);
  }

  // Revised: ConceptSelector onSelectAll passes full domain ids or [] for deselect
  function handleCreateConceptSelectAll(ids: string[], allDomainIds: string[]) {
    if (ids.length === 0) {
      deselectAllCreateDomain(allDomainIds);
    } else {
      selectAllCreateDomain(ids);
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers: create plan
  // ---------------------------------------------------------------------------

  async function handleCreatePlan(e: React.FormEvent) {
    e.preventDefault();
    if (!createTitle.trim() || createSelectedConcepts.size === 0) {
      setCreateError('Title and at least one concept are required.');
      return;
    }
    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const body: Record<string, unknown> = {
        title: createTitle.trim(),
        strategy: createStrategy,
        conceptIds: Array.from(createSelectedConcepts),
        targetBloom: createTargetBloom,
        checkpointIntervalDays: createCheckpointDays,
      };
      if (createStrategy === 'exam-prep' && createExamDate) body.examDate = createExamDate;
      if (createLearningObjectives.trim()) body.learningObjectives = createLearningObjectives.trim();
      if (createDesiredOutcomes.trim()) body.desiredOutcomes = createDesiredOutcomes.trim();
      if (createStudySchedule.trim()) body.studySchedule = createStudySchedule.trim();
      if (createImplementationIntention.trim()) body.implementationIntention = createImplementationIntention.trim();
      if (createObstacle.trim()) body.obstacle = createObstacle.trim();

      const res = await fetch('/api/study/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { planId?: string; error?: string };
      if (data.error || !data.planId) {
        setCreateError(data.error ?? 'Failed to create plan.');
        return;
      }
      await fetchPlans();
      await fetchPlanDetail(data.planId);
      setView('detail');
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreateSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers: detail view actions
  // ---------------------------------------------------------------------------

  async function handleArchivePlan() {
    if (!selectedPlan) return;
    await fetch(`/api/study/plans/${selectedPlan.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    });
    await fetchPlans();
    goToList();
  }

  async function handleCompletePlan() {
    if (!selectedPlan) return;
    await fetch(`/api/study/plans/${selectedPlan.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    await fetchPlans();
    goToList();
  }

  async function handleRemoveConcept(conceptId: string) {
    if (!selectedPlan) return;
    const ok = window.confirm('Remove this concept from the plan?');
    if (!ok) return;
    await fetch(`/api/study/plans/${selectedPlan.id}/concepts`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conceptId }),
    });
    await fetchPlanDetail(selectedPlan.id);
  }

  async function handleAddConcepts() {
    if (!selectedPlan || addConceptsSelected.size === 0) return;
    setAddConceptsSubmitting(true);
    try {
      await fetch(`/api/study/plans/${selectedPlan.id}/concepts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conceptIds: Array.from(addConceptsSelected) }),
      });
      setShowAddConcepts(false);
      setAddConceptsSelected(new Set());
      await fetchPlanDetail(selectedPlan.id);
    } finally {
      setAddConceptsSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const activePlans = plans.filter((p) => p.status === 'active');
  const inactivePlans = plans.filter((p) => p.status !== 'active');

  const existingConceptIds = new Set(selectedPlan?.concepts.map((c) => c.conceptId) ?? []);

  // Sort detail concepts: furthest from target first
  const sortedDetailConcepts = selectedPlan
    ? [...selectedPlan.concepts].sort((a, b) => {
        const gapA = a.targetBloom - a.bloomCeiling;
        const gapB = b.targetBloom - b.bloomCeiling;
        return gapB - gapA;
      })
    : [];

  // ---------------------------------------------------------------------------
  // Render: loading
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-gray-500">Loading...</p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: LIST view
  // ---------------------------------------------------------------------------

  if (view === 'list') {
    return (
      <div className="max-w-3xl space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-100">Study Plans</h2>
          <button
            onClick={goToCreate}
            className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
          >
            New Plan
          </button>
        </div>

        {/* Active plans */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Active Plans
            {activePlans.length > 0 && (
              <span className="ml-2 text-gray-600 normal-case font-normal">({activePlans.length})</span>
            )}
          </h3>
          {activePlans.length === 0 ? (
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center">
              <p className="text-sm text-gray-500">No active plans. Create one to get started.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {activePlans.map((plan) => (
                <button
                  key={plan.id}
                  onClick={() => goToDetail(plan)}
                  className="w-full text-left rounded-lg border border-gray-800 bg-gray-900 p-4 hover:border-gray-700 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-gray-100 truncate">{plan.title}</span>
                      <StrategyBadge strategy={plan.strategy} />
                    </div>
                    <span className="shrink-0 text-xs text-gray-500">
                      {plan.conceptCount} concept{plan.conceptCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    <ProgressBar pct={plan.progressPercent} />
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>{Math.round(plan.progressPercent)}% at target</span>
                      {plan.nextCheckpointAt && (
                        <span>Checkpoint {formatDate(plan.nextCheckpointAt)}</span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Archived / completed plans */}
        {inactivePlans.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
              Archived / Completed
              <span className="ml-2 text-gray-600 normal-case font-normal">({inactivePlans.length})</span>
            </h3>
            <div className="space-y-2">
              {inactivePlans.map((plan) => (
                <button
                  key={plan.id}
                  onClick={() => goToDetail(plan)}
                  className="w-full text-left rounded-lg border border-gray-800 bg-gray-950 p-3 hover:border-gray-700 transition-colors opacity-60 hover:opacity-80"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-300">{plan.title}</span>
                    <StrategyBadge strategy={plan.strategy} />
                    <span className="text-xs text-gray-600 capitalize ml-auto">{plan.status}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: CREATE view
  // ---------------------------------------------------------------------------

  if (view === 'create') {
    return (
      <div className="max-w-2xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-100">New Study Plan</h2>
          <button
            onClick={goToList}
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            Cancel
          </button>
        </div>

        <form onSubmit={handleCreatePlan} className="space-y-6">
          {/* Title */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-300">Title *</label>
            <input
              type="text"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="e.g. Algorithms Exam Prep"
              required
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-gray-500"
            />
          </div>

          {/* Strategy */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Strategy</label>
            <div className="flex flex-wrap gap-2">
              {STRATEGY_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-center gap-1.5 cursor-pointer px-3 py-1.5 rounded-full text-sm transition-colors ${
                    createStrategy === opt.value
                      ? STRATEGY_BADGE[opt.value]
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="strategy"
                    value={opt.value}
                    checked={createStrategy === opt.value}
                    onChange={() => setCreateStrategy(opt.value)}
                    className="sr-only"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          {/* Exam date (only for exam-prep) */}
          {createStrategy === 'exam-prep' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">Exam Date</label>
              <input
                type="date"
                value={createExamDate}
                onChange={(e) => setCreateExamDate(e.target.value)}
                className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-500"
              />
            </div>
          )}

          {/* Target Bloom */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-300">
              Target Bloom Level: <span className="text-blue-400">{BLOOM_LABELS[createTargetBloom] ?? `L${createTargetBloom}`}</span>
            </label>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setCreateTargetBloom(n)}
                  className={`flex-1 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    createTargetBloom === n
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  L{n}
                </button>
              ))}
            </div>
          </div>

          {/* Concept selector */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">
              Concepts *
              {createSelectedConcepts.size > 0 && (
                <span className="ml-2 text-blue-400 font-normal">{createSelectedConcepts.size} selected</span>
              )}
            </label>
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 max-h-72 overflow-y-auto">
              <ConceptSelectorForCreate
                allConcepts={allConcepts}
                selected={createSelectedConcepts}
                onToggle={toggleCreateConcept}
                onSelectAllDomain={handleCreateConceptSelectAll}
              />
            </div>
          </div>

          {/* Advanced section */}
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-sm text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
            >
              <span>{showAdvanced ? '▾' : '▸'}</span>
              Advanced
            </button>

            {showAdvanced && (
              <div className="space-y-4 pl-4 border-l border-gray-800">
                <div className="space-y-1.5">
                  <label className="text-sm text-gray-400">Learning Objectives</label>
                  <textarea
                    value={createLearningObjectives}
                    onChange={(e) => setCreateLearningObjectives(e.target.value)}
                    rows={3}
                    placeholder="What do you want to be able to do?"
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 resize-none focus:outline-none focus:border-gray-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm text-gray-400">Desired Outcomes</label>
                  <textarea
                    value={createDesiredOutcomes}
                    onChange={(e) => setCreateDesiredOutcomes(e.target.value)}
                    rows={3}
                    placeholder="What will success look like?"
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 resize-none focus:outline-none focus:border-gray-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm text-gray-400">Study Schedule</label>
                  <input
                    type="text"
                    value={createStudySchedule}
                    onChange={(e) => setCreateStudySchedule(e.target.value)}
                    placeholder="e.g. Weekdays 8–9am"
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm text-gray-400">Implementation Intention</label>
                  <input
                    type="text"
                    value={createImplementationIntention}
                    onChange={(e) => setCreateImplementationIntention(e.target.value)}
                    placeholder="When I sit down to study, I will..."
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm text-gray-400">Anticipated Obstacle</label>
                  <input
                    type="text"
                    value={createObstacle}
                    onChange={(e) => setCreateObstacle(e.target.value)}
                    placeholder="What might get in the way?"
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm text-gray-400">
                    Checkpoint Interval (days)
                  </label>
                  <input
                    type="number"
                    value={createCheckpointDays}
                    onChange={(e) => setCreateCheckpointDays(Number(e.target.value))}
                    min={1}
                    max={90}
                    className="w-24 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-500"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Error */}
          {createError && (
            <p className="text-sm text-red-400">{createError}</p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={createSubmitting}
              className="px-5 py-2 rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              {createSubmitting ? 'Creating...' : 'Create Plan'}
            </button>
            <a
              href="/study/chat?method=plan"
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              Or: Plan with AI
            </a>
          </div>
        </form>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: DETAIL view
  // ---------------------------------------------------------------------------

  if (view === 'detail') {
    if (detailLoading || !selectedPlan) {
      return (
        <div className="flex items-center justify-center py-20">
          <p className="text-sm text-gray-500">Loading plan...</p>
        </div>
      );
    }

    return (
      <div className="max-w-3xl space-y-6">
        {/* Back link */}
        <button
          onClick={goToList}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
        >
          ← Back to Plans
        </button>

        {/* Plan header */}
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-gray-100">{selectedPlan.title}</h2>
              <div className="flex items-center gap-2">
                <StrategyBadge strategy={selectedPlan.strategy} />
                <span className="text-xs text-gray-500">
                  Created {formatDate(selectedPlan.createdAt)}
                </span>
                {selectedPlan.nextCheckpointAt && (
                  <span className="text-xs text-gray-500">
                    · Next checkpoint {formatDate(selectedPlan.nextCheckpointAt)}
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => router.push(`/study/session?planId=${selectedPlan.id}`)}
              className="shrink-0 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
            >
              Start Plan Session
            </button>
          </div>

          {/* Progress */}
          <div className="space-y-1.5">
            <ProgressBar pct={selectedPlan.progressPercent} />
            <p className="text-xs text-gray-500">
              {Math.round(selectedPlan.progressPercent)}% of concepts at target · {selectedPlan.conceptCount} total
            </p>
          </div>
        </div>

        {/* Concept checklist */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Concepts</h3>
            <button
              onClick={() => {
                setShowAddConcepts(!showAddConcepts);
                setAddConceptsSelected(new Set());
              }}
              className="text-xs px-3 py-1.5 rounded-md bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
            >
              {showAddConcepts ? 'Cancel' : 'Add Concepts'}
            </button>
          </div>

          {/* Add concepts panel */}
          {showAddConcepts && (
            <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-4">
              <ConceptSelectorForCreate
                allConcepts={allConcepts}
                selected={addConceptsSelected}
                onToggle={(id) => {
                  setAddConceptsSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                }}
                onSelectAllDomain={(ids, domainIds) => {
                  if (ids.length === 0) {
                    setAddConceptsSelected((prev) => {
                      const next = new Set(prev);
                      domainIds.forEach((id) => next.delete(id));
                      return next;
                    });
                  } else {
                    setAddConceptsSelected((prev) => {
                      const next = new Set(prev);
                      ids.forEach((id) => next.add(id));
                      return next;
                    });
                  }
                }}
                excludeIds={existingConceptIds}
              />
              <button
                onClick={handleAddConcepts}
                disabled={addConceptsSelected.size === 0 || addConceptsSubmitting}
                className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              >
                {addConceptsSubmitting
                  ? 'Adding...'
                  : addConceptsSelected.size > 0
                    ? `Add ${addConceptsSelected.size} concept${addConceptsSelected.size !== 1 ? 's' : ''}`
                    : 'Add Concepts'}
              </button>
            </div>
          )}

          {/* Concept list */}
          {sortedDetailConcepts.length === 0 ? (
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-center">
              <p className="text-sm text-gray-500">No concepts in this plan.</p>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-900 border-b border-gray-800">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">Concept</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider hidden sm:table-cell">Domain</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-32">Bloom</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-28">Mastery</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider w-16">Done</th>
                    <th className="px-4 py-3 w-12" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800 bg-gray-950">
                  {sortedDetailConcepts.map((c) => (
                    <tr key={c.conceptId} className="hover:bg-gray-900 transition-colors">
                      <td className="px-4 py-3 text-gray-100 font-medium">{c.title}</td>
                      <td className="px-4 py-3 text-gray-400 hidden sm:table-cell">{c.domain ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        L{c.bloomCeiling} → <span className="text-blue-400">L{c.targetBloom}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden w-20">
                          <div
                            className="h-full bg-blue-500 rounded-full"
                            style={{ width: `${Math.round(c.masteryOverall * 100)}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {c.atTarget ? (
                          <span className="text-green-400 text-base">✓</span>
                        ) : (
                          <span className="text-gray-600 text-base">–</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleRemoveConcept(c.conceptId)}
                          className="text-xs text-gray-600 hover:text-red-400 transition-colors"
                          title="Remove from plan"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Danger zone */}
        {selectedPlan.status === 'active' && (
          <section className="flex items-center gap-3 pt-2">
            <button
              onClick={handleCompletePlan}
              className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-medium transition-colors"
            >
              Mark Complete
            </button>
            <button
              onClick={handleArchivePlan}
              className="px-4 py-2 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
            >
              Archive Plan
            </button>
          </section>
        )}
      </div>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal concept selector (with domain-aware toggle)
// ---------------------------------------------------------------------------

interface InternalConceptSelectorProps {
  allConcepts: ConceptSummary[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAllDomain: (ids: string[], allDomainIds: string[]) => void;
  excludeIds?: Set<string>;
}

function ConceptSelectorForCreate({
  allConcepts,
  selected,
  onToggle,
  onSelectAllDomain,
  excludeIds,
}: InternalConceptSelectorProps) {
  const filtered = excludeIds
    ? allConcepts.filter((c) => !excludeIds.has(c.id))
    : allConcepts;

  // Group by domain
  const domainMap = new Map<string, ConceptSummary[]>();
  for (const c of filtered) {
    const key = c.domain ?? 'Uncategorised';
    if (!domainMap.has(key)) domainMap.set(key, []);
    domainMap.get(key)!.push(c);
  }

  if (filtered.length === 0) {
    return <p className="text-sm text-gray-500">No concepts available.</p>;
  }

  return (
    <div className="space-y-4">
      {Array.from(domainMap.entries()).map(([domain, concepts]) => {
        const domainIds = concepts.map((c) => c.id);
        const allSel = domainIds.every((id) => selected.has(id));
        return (
          <div key={domain} className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">{domain}</span>
              <button
                type="button"
                onClick={() =>
                  allSel
                    ? onSelectAllDomain([], domainIds)
                    : onSelectAllDomain(domainIds, domainIds)
                }
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                {allSel ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {concepts.map((c) => (
                <label
                  key={c.id}
                  className={`flex items-center gap-1.5 cursor-pointer text-xs px-2.5 py-1.5 rounded-md border transition-colors ${
                    selected.has(c.id)
                      ? 'bg-blue-900/40 border-blue-700 text-blue-200'
                      : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => onToggle(c.id)}
                    className="w-3 h-3 accent-blue-500"
                  />
                  {c.title}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
