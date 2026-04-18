/**
 * Session composition builder.
 *
 * Builds a structured study session from due activities, applying the
 * new-material / review / stretch block layout from spec Section 4.5.
 */

import { getDueActivities, getActiveConcepts, getPlanConceptIds, getActivitiesByConceptId } from './study-db';
import type { ConceptSummary } from './study-db';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionBlock {
  type: 'new' | 'review' | 'stretch';
  activities: SessionActivity[];
}

export interface SessionActivity {
  activityId: string;
  conceptId: string;
  conceptTitle: string;
  domain: string | null;
  activityType: string;
  bloomLevel: number;
}

export interface SessionComposition {
  blocks: SessionBlock[];
  totalActivities: number;
  estimatedMinutes: number;
  domainsCovered: string[];
}

export interface SessionOptions {
  targetActivities?: number;
  domainFocus?: string;
  planId?: string;
  conceptId?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ACTIVITY_MINUTES: Record<string, number> = {
  card_review: 1.5,
  elaboration: 3,
  self_explain: 5,
  comparison: 5,
  case_analysis: 5,
  concept_map: 5,
  synthesis: 7,
  socratic: 7,
};

function estimateMinutes(activityType: string): number {
  return ACTIVITY_MINUTES[activityType] ?? 3;
}

/**
 * Interleave activities so no two consecutive items share the same concept_id.
 * Uses a greedy pass: place items one-by-one from the sorted list, deferring
 * any item whose concept_id matches the previous placement to the end.
 */
function interleave(items: SessionActivity[]): SessionActivity[] {
  const result: SessionActivity[] = [];
  const deferred: SessionActivity[] = [];

  for (const item of items) {
    const prev = result[result.length - 1];
    if (prev && prev.conceptId === item.conceptId) {
      deferred.push(item);
    } else {
      result.push(item);
    }
  }

  // Append deferred items, applying the same rule
  for (const item of deferred) {
    const prev = result[result.length - 1];
    if (prev && prev.conceptId === item.conceptId) {
      // Still clashes — just append, best-effort
      result.push(item);
    } else {
      result.push(item);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build a session composition from due activities.
 *
 * Returns an empty composition when there are no due activities.
 */
export function buildSessionComposition(
  options?: SessionOptions,
): SessionComposition {
  // Concept-focused sessions include ALL activities (not just due),
  // since the user is explicitly choosing to practice this concept now.
  const dueActivities = options?.conceptId
    ? getActivitiesByConceptId(options.conceptId)
    : getDueActivities();

  if (dueActivities.length === 0) {
    return { blocks: [], totalActivities: 0, estimatedMinutes: 0, domainsCovered: [] };
  }

  // Plan filtering (conceptId already filtered above)
  let activitiesToUse = dueActivities;
  if (options?.planId) {
    const planConceptIds = new Set(getPlanConceptIds(options.planId));
    activitiesToUse = dueActivities.filter(a => planConceptIds.has(a.concept_id));
  }

  const activeConcepts = getActiveConcepts();

  // Build concept lookup map keyed by id
  const conceptMap = new Map<string, ConceptSummary>();
  for (const concept of activeConcepts) {
    conceptMap.set(concept.id, concept);
  }

  // Enrich due activities with concept metadata; skip if concept missing
  interface EnrichedActivity extends SessionActivity {
    dueAt: string;
    easeFactor: number;
    bloomCeiling: number;
  }

  const enriched: EnrichedActivity[] = [];
  for (const act of activitiesToUse) {
    const concept = conceptMap.get(act.concept_id);
    if (!concept) continue;

    enriched.push({
      activityId: act.id,
      conceptId: act.concept_id,
      conceptTitle: concept.title,
      domain: concept.domain,
      activityType: act.activity_type,
      bloomLevel: act.bloom_level,
      dueAt: act.due_at,
      easeFactor: act.ease_factor ?? 2.5,
      bloomCeiling: concept.bloomCeiling,
    });
  }

  // Apply domain filter if requested
  const filtered =
    options?.domainFocus
      ? enriched.filter((a) => a.domain === options.domainFocus)
      : enriched;

  if (filtered.length === 0) {
    return { blocks: [], totalActivities: 0, estimatedMinutes: 0, domainsCovered: [] };
  }

  const target = options?.targetActivities ?? 20;

  // -------------------------------------------------------------------------
  // New material block (~30%): bloom_level 1-2 where concept bloomCeiling < 3
  // Grouped by domain for topic coherence (not interleaved)
  // -------------------------------------------------------------------------
  const newTarget = Math.ceil(target * 0.3);

  const newCandidates = filtered.filter(
    (a) => a.bloomLevel <= 2 && a.bloomCeiling < 3,
  );

  // Group by domain
  const byDomain = new Map<string, EnrichedActivity[]>();
  for (const a of newCandidates) {
    const key = a.domain ?? '\x00null';
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key)!.push(a);
  }

  const newBlock: SessionActivity[] = [];
  outer: for (const group of byDomain.values()) {
    for (const a of group) {
      if (newBlock.length >= newTarget) break outer;
      newBlock.push({
        activityId: a.activityId,
        conceptId: a.conceptId,
        conceptTitle: a.conceptTitle,
        domain: a.domain,
        activityType: a.activityType,
        bloomLevel: a.bloomLevel,
      });
    }
  }

  const newIds = new Set(newBlock.map((a) => a.activityId));

  // -------------------------------------------------------------------------
  // Review block (~50%): remaining due activities, sorted overdue-first then
  // lowest ease_factor, interleaved by concept
  // -------------------------------------------------------------------------
  const reviewTarget = Math.ceil(target * 0.5);

  const reviewCandidates = filtered
    .filter((a) => !newIds.has(a.activityId))
    .sort((a, b) => {
      const dueDiff = a.dueAt.localeCompare(b.dueAt);
      if (dueDiff !== 0) return dueDiff;
      return a.easeFactor - b.easeFactor;
    });

  const reviewRaw: SessionActivity[] = reviewCandidates.slice(0, reviewTarget).map((a) => ({
    activityId: a.activityId,
    conceptId: a.conceptId,
    conceptTitle: a.conceptTitle,
    domain: a.domain,
    activityType: a.activityType,
    bloomLevel: a.bloomLevel,
  }));

  let reviewBlock = interleave(reviewRaw);

  const reviewIds = new Set(reviewBlock.map((a) => a.activityId));

  // -------------------------------------------------------------------------
  // Stretch block (~20%): bloom_level >= 4 where concept bloomCeiling >= 4,
  // not already in review block
  // -------------------------------------------------------------------------
  const stretchTarget = Math.ceil(target * 0.2);

  const stretchBlock: SessionActivity[] = filtered
    .filter(
      (a) =>
        a.bloomLevel >= 4 &&
        a.bloomCeiling >= 4 &&
        !reviewIds.has(a.activityId),
    )
    .slice(0, stretchTarget)
    .map((a) => ({
      activityId: a.activityId,
      conceptId: a.conceptId,
      conceptTitle: a.conceptTitle,
      domain: a.domain,
      activityType: a.activityType,
      bloomLevel: a.bloomLevel,
    }));

  // -------------------------------------------------------------------------
  // Fill: if total < target, pull more from remaining due pool into review
  // -------------------------------------------------------------------------
  const usedIds = new Set([
    ...newIds,
    ...reviewIds,
    ...stretchBlock.map((a) => a.activityId),
  ]);

  const totalSoFar = newBlock.length + reviewBlock.length + stretchBlock.length;

  if (totalSoFar < target) {
    const remaining = filtered
      .filter((a) => !usedIds.has(a.activityId))
      .slice(0, target - totalSoFar)
      .map((a) => ({
        activityId: a.activityId,
        conceptId: a.conceptId,
        conceptTitle: a.conceptTitle,
        domain: a.domain,
        activityType: a.activityType,
        bloomLevel: a.bloomLevel,
      }));

    reviewBlock = interleave([...reviewBlock, ...remaining]);
  }

  // -------------------------------------------------------------------------
  // Assemble final composition
  // -------------------------------------------------------------------------
  const blocks: SessionBlock[] = [];
  if (newBlock.length > 0) blocks.push({ type: 'new', activities: newBlock });
  if (reviewBlock.length > 0) blocks.push({ type: 'review', activities: reviewBlock });
  if (stretchBlock.length > 0) blocks.push({ type: 'stretch', activities: stretchBlock });

  const allActivities = [...newBlock, ...reviewBlock, ...stretchBlock];

  const estimatedMinutes = allActivities.reduce(
    (sum, a) => sum + estimateMinutes(a.activityType),
    0,
  );

  const domainsCovered = [
    ...new Set(
      allActivities.map((a) => a.domain).filter((d): d is string => d !== null),
    ),
  ];

  return {
    blocks,
    totalActivities: allActivities.length,
    estimatedMinutes,
    domainsCovered,
  };
}
