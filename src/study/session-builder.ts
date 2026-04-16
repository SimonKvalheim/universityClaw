import {
  getDueActivities,
  getActiveConcepts,
  getPlanConceptIds,
  getStudyPlanById,
  type Concept,
  type LearningActivity,
} from './queries.js';
import type {
  SessionComposition,
  SessionBlock,
  SessionActivity,
  SessionOptions,
  ActivityType,
  BloomLevel,
} from './types.js';

// ─── Time estimates per activity type (minutes) ───────────────────────────────

const MINUTES_PER_TYPE: Record<ActivityType, number> = {
  card_review: 1.5,
  elaboration: 3,
  self_explain: 5,
  comparison: 5,
  case_analysis: 5,
  concept_map: 5,
  synthesis: 7,
  socratic: 7,
};

function estimateMinutes(activityType: ActivityType): number {
  return MINUTES_PER_TYPE[activityType] ?? 3;
}

// ─── Enrich activity into SessionActivity ─────────────────────────────────────

function toSessionActivity(
  activity: LearningActivity,
  concept: Concept,
): SessionActivity {
  return {
    activityId: activity.id,
    conceptId: activity.conceptId,
    conceptTitle: concept.title,
    domain: concept.domain ?? null,
    activityType: activity.activityType as ActivityType,
    bloomLevel: activity.bloomLevel as BloomLevel,
  };
}

// ─── Interleave so no two consecutive share the same conceptId ────────────────

function interleaveByConceptId(
  activities: SessionActivity[],
): SessionActivity[] {
  const result: SessionActivity[] = [];
  const remaining = [...activities];

  while (remaining.length > 0) {
    const prevConceptId =
      result.length > 0 ? result[result.length - 1].conceptId : null;
    const idx = remaining.findIndex((a) => a.conceptId !== prevConceptId);
    if (idx === -1) {
      // All remaining share the same conceptId — append them (tail is acceptable)
      result.push(...remaining.splice(0));
    } else {
      result.push(...remaining.splice(idx, 1));
    }
  }

  return result;
}

// ─── Main session builder ─────────────────────────────────────────────────────

export function buildDailySession(
  options?: SessionOptions,
): SessionComposition {
  let target = options?.targetActivities ?? 20;

  // 1. Fetch due activities and active concepts
  const dueActivities = getDueActivities();
  if (dueActivities.length === 0) {
    return {
      blocks: [],
      totalActivities: 0,
      estimatedMinutes: 0,
      domainsCovered: [],
    };
  }

  const activeConcepts = getActiveConcepts();
  const conceptMap = new Map<string, Concept>(
    activeConcepts.map((c) => [c.id, c]),
  );

  // 1b. Plan concept filtering
  let activitiesToUse = dueActivities;
  if (options?.planId) {
    const planConceptIds = new Set(getPlanConceptIds(options.planId));
    activitiesToUse = dueActivities.filter((a) =>
      planConceptIds.has(a.conceptId),
    );
  }

  // 1c. Exam-prep: increase target when exam is imminent
  if (options?.planId) {
    const plan = getStudyPlanById(options.planId);
    if (plan?.strategy === 'exam-prep' && plan.config) {
      try {
        const config = JSON.parse(plan.config as string);
        if (config.exam_date) {
          const daysUntilExam = Math.ceil(
            (new Date(config.exam_date).getTime() - Date.now()) /
              (1000 * 60 * 60 * 24),
          );
          if (daysUntilExam < 7 && !options.targetActivities) {
            target = 30;
          }
        }
      } catch {
        /* ignore invalid config */
      }
    }
  }

  // 2. Enrich and filter activities
  let enriched: Array<{ activity: LearningActivity; concept: Concept }> = [];
  for (const activity of activitiesToUse) {
    const concept = conceptMap.get(activity.conceptId);
    if (!concept) continue; // silently skip orphaned activities
    enriched.push({ activity, concept });
  }

  // 3. Domain focus filter
  if (options?.domainFocus) {
    const focus = options.domainFocus;
    enriched = enriched.filter((e) => e.concept.domain === focus);
  }

  if (enriched.length === 0) {
    return {
      blocks: [],
      totalActivities: 0,
      estimatedMinutes: 0,
      domainsCovered: [],
    };
  }

  // ─── Block targets ────────────────────────────────────────────────────────
  const newTarget = Math.floor(target * 0.3);
  const reviewTarget = Math.floor(target * 0.5);
  const stretchTarget = target - newTarget - reviewTarget; // ~20%

  // ─── Pre-identify stretch candidates so they aren't consumed by review ───
  // (stretch: bloomLevel >= 4 AND concept bloomCeiling >= 4)
  const stretchCandidateIds = new Set<string>(
    enriched
      .filter(
        (e) => e.activity.bloomLevel >= 4 && (e.concept.bloomCeiling ?? 0) >= 4,
      )
      .slice(0, stretchTarget)
      .map((e) => e.activity.id),
  );

  // ─── New block: L1-2 where concept bloomCeiling < 3, grouped by domain ───
  const newCandidates = enriched.filter(
    (e) =>
      !stretchCandidateIds.has(e.activity.id) &&
      (e.activity.bloomLevel === 1 || e.activity.bloomLevel === 2) &&
      (e.concept.bloomCeiling ?? 0) < 3,
  );

  // Group by domain for topic coherence
  const newByDomain = new Map<string | null, typeof newCandidates>();
  for (const e of newCandidates) {
    const domain = e.concept.domain ?? null;
    if (!newByDomain.has(domain)) newByDomain.set(domain, []);
    newByDomain.get(domain)!.push(e);
  }

  const newSelected: typeof newCandidates = [];
  for (const group of newByDomain.values()) {
    newSelected.push(...group);
    if (newSelected.length >= newTarget) break;
  }
  const newActivities: SessionActivity[] = newSelected
    .slice(0, newTarget)
    .map((e) => toSessionActivity(e.activity, e.concept));

  const placedIds = new Set(newActivities.map((a) => a.activityId));

  // ─── Review block: remaining (excluding stretch candidates), sorted overdue → low easeFactor
  const reviewCandidates = enriched.filter(
    (e) =>
      !placedIds.has(e.activity.id) && !stretchCandidateIds.has(e.activity.id),
  );

  // Sort: most overdue first (ascending dueAt), then lowest easeFactor
  reviewCandidates.sort((a, b) => {
    const dateCmp = a.activity.dueAt.localeCompare(b.activity.dueAt);
    if (dateCmp !== 0) return dateCmp;
    return (a.activity.easeFactor ?? 2.5) - (b.activity.easeFactor ?? 2.5);
  });

  const reviewSessions: SessionActivity[] = reviewCandidates.map((e) =>
    toSessionActivity(e.activity, e.concept),
  );

  const interleaved = interleaveByConceptId(reviewSessions);
  const reviewActivities = interleaved.slice(0, reviewTarget);

  for (const a of reviewActivities) placedIds.add(a.activityId);

  // ─── Stretch block: use the pre-identified candidates
  const stretchActivities: SessionActivity[] = enriched
    .filter((e) => stretchCandidateIds.has(e.activity.id))
    .map((e) => toSessionActivity(e.activity, e.concept));

  for (const a of stretchActivities) placedIds.add(a.activityId);

  // ─── Domain coverage: ensure all active domains with due activities appear ─
  // Determine domains present in due activities
  const dueDomains = new Set<string>();
  for (const e of enriched) {
    if (e.concept.domain) dueDomains.add(e.concept.domain);
  }

  const coveredNow = new Set<string>();
  for (const a of [
    ...newActivities,
    ...reviewActivities,
    ...stretchActivities,
  ]) {
    if (a.domain) coveredNow.add(a.domain);
  }

  // Swap in missing domains (best-effort: replace lowest-priority review activity)
  for (const missingDomain of dueDomains) {
    if (coveredNow.has(missingDomain)) continue;

    // Find a due activity from the missing domain not yet placed
    const candidate = enriched.find(
      (e) =>
        e.concept.domain === missingDomain && !placedIds.has(e.activity.id),
    );
    if (!candidate) continue;

    // Find the last review activity to swap out (lowest priority)
    if (reviewActivities.length > 0) {
      const removed = reviewActivities.pop()!;
      placedIds.delete(removed.activityId);
      const swapIn = toSessionActivity(candidate.activity, candidate.concept);
      reviewActivities.push(swapIn);
      placedIds.add(swapIn.activityId);
      coveredNow.add(missingDomain);
    }
  }

  // ─── Fill remaining slots from pool if total < target ─────────────────────
  const totalSoFar =
    newActivities.length + reviewActivities.length + stretchActivities.length;
  const fillSlots = target - totalSoFar;
  if (fillSlots > 0) {
    const remaining = enriched.filter((e) => !placedIds.has(e.activity.id));
    for (const e of remaining.slice(0, fillSlots)) {
      reviewActivities.push(toSessionActivity(e.activity, e.concept));
      placedIds.add(e.activity.id);
    }
  }

  // ─── Build blocks (only non-empty) ────────────────────────────────────────
  const blocks: SessionBlock[] = [];
  if (newActivities.length > 0)
    blocks.push({ type: 'new', activities: newActivities });
  if (reviewActivities.length > 0)
    blocks.push({ type: 'review', activities: reviewActivities });
  if (stretchActivities.length > 0)
    blocks.push({ type: 'stretch', activities: stretchActivities });

  const allPlaced = [
    ...newActivities,
    ...reviewActivities,
    ...stretchActivities,
  ];

  // ─── Estimate minutes ─────────────────────────────────────────────────────
  const estimatedMinutes = allPlaced.reduce(
    (sum, a) => sum + estimateMinutes(a.activityType as ActivityType),
    0,
  );

  // ─── Unique domains covered ───────────────────────────────────────────────
  const domainsCovered = [
    ...new Set(
      allPlaced.map((a) => a.domain).filter((d): d is string => d !== null),
    ),
  ];

  return {
    blocks,
    totalActivities: allPlaced.length,
    estimatedMinutes,
    domainsCovered,
  };
}
