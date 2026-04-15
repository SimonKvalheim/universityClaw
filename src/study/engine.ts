/**
 * Study Engine — concept progression logic
 *
 * Reads DB state via query functions and returns recommendations.
 * No container spawning, no LLM calls.
 * All DB access goes through queries.ts — never imports getDb() directly.
 */

import {
  getConceptById,
  getActivitiesByConcept,
  getActivityById,
  getRecentActivityLogs,
  getConceptsAboveBloomCeiling,
  getLogsByConceptAndLevel,
  completeActivity,
  type CompleteActivityInput,
} from './queries.js';
import { computeMastery, computeBloomCeiling } from './mastery.js';
import type {
  BloomLevel,
  BloomAdvancement,
  ActivityRecommendation,
  CompletionResult,
  SynthesisOpportunity,
} from './types.js';

// ====================================================================
// getConceptRecommendations
// ====================================================================

/**
 * Returns recommended activities for a concept based on its bloomCeiling.
 *
 * bloomCeiling < 3  → card_review (L1, count 3–5) + elaboration (L2, count 2)
 * bloomCeiling 3–4  → self_explain/concept_map (L3) + comparison/case_analysis (L4), count 1 each
 * bloomCeiling >= 5 → synthesis (L5) + socratic (L6) + case_analysis (L5), count 1 each
 */
export function getConceptRecommendations(
  conceptId: string,
): ActivityRecommendation[] {
  const concept = getConceptById(conceptId);
  if (!concept) throw new Error(`Concept not found: ${conceptId}`);

  const ceiling = concept.bloomCeiling ?? 0;

  if (ceiling < 3) {
    return [
      { activityType: 'card_review', bloomLevel: 1 as BloomLevel, count: 4 },
      { activityType: 'elaboration', bloomLevel: 2 as BloomLevel, count: 2 },
    ];
  }

  if (ceiling <= 4) {
    return [
      { activityType: 'self_explain', bloomLevel: 3 as BloomLevel, count: 1 },
      { activityType: 'concept_map', bloomLevel: 3 as BloomLevel, count: 1 },
      { activityType: 'comparison', bloomLevel: 4 as BloomLevel, count: 1 },
      { activityType: 'case_analysis', bloomLevel: 4 as BloomLevel, count: 1 },
    ];
  }

  // ceiling >= 5
  return [
    { activityType: 'synthesis', bloomLevel: 5 as BloomLevel, count: 1 },
    { activityType: 'socratic', bloomLevel: 6 as BloomLevel, count: 1 },
    { activityType: 'case_analysis', bloomLevel: 5 as BloomLevel, count: 1 },
  ];
}

// ====================================================================
// checkForAdvancement
// ====================================================================

/**
 * Standalone utility: checks whether a concept has earned enough mastery
 * evidence to advance its bloomCeiling. Returns null if no advancement.
 *
 * Does NOT reuse processCompletion — this is an independent utility for
 * external callers (e.g. dashboard, background jobs).
 */
export function checkForAdvancement(
  conceptId: string,
): BloomAdvancement | null {
  const concept = getConceptById(conceptId);
  if (!concept) throw new Error(`Concept not found: ${conceptId}`);

  // Get ALL activity logs for this concept (no bloom level filter)
  const logs = getLogsByConceptAndLevel(conceptId);

  const masteryInput = logs.map((log) => ({
    bloomLevel: log.bloomLevel as BloomLevel,
    quality: log.quality,
    reviewedAt: log.reviewedAt,
  }));

  const levels = computeMastery(masteryInput);
  const newCeiling = computeBloomCeiling(levels);
  const previousCeiling = concept.bloomCeiling ?? 0;

  if (newCeiling <= previousCeiling) {
    return null;
  }

  // Check if activities already exist at the new level
  const existingActivities = getActivitiesByConcept(conceptId);
  const generationNeeded = !existingActivities.some(
    (a) => a.bloomLevel >= newCeiling,
  );

  return {
    conceptId,
    conceptTitle: concept.title,
    previousCeiling,
    newCeiling,
    generationNeeded,
  };
}

// ====================================================================
// processCompletion
// ====================================================================

/**
 * Completes an activity and returns the full engine-level result.
 *
 * Uses bloomCeilingBefore/After from completeActivity() — does NOT
 * call checkForAdvancement() internally.
 */
export function processCompletion(
  input: CompleteActivityInput,
): CompletionResult {
  // Look up activity first to get conceptId (throws if not found)
  const activity = getActivityById(input.activityId);
  if (!activity) throw new Error(`Activity not found: ${input.activityId}`);

  const conceptId = activity.conceptId;

  // Delegate to queries — runs full SM-2 + mastery update atomically
  const { logEntryId, newDueAt, bloomCeilingBefore, bloomCeilingAfter } =
    completeActivity(input);

  let advancement: BloomAdvancement | null = null;
  let generationNeeded = false;

  if (bloomCeilingAfter > bloomCeilingBefore) {
    const concept = getConceptById(conceptId);
    const existingActivities = getActivitiesByConcept(conceptId);
    generationNeeded = !existingActivities.some(
      (a) => a.bloomLevel >= bloomCeilingAfter,
    );

    advancement = {
      conceptId,
      conceptTitle: concept?.title ?? conceptId,
      previousCeiling: bloomCeilingBefore,
      newCeiling: bloomCeilingAfter,
      generationNeeded,
    };
  }

  const deEscalation = getDeEscalationAdvice(conceptId);

  return {
    logEntryId,
    newDueAt,
    advancement,
    generationNeeded,
    deEscalation,
  };
}

// ====================================================================
// getDeEscalationAdvice
// ====================================================================

/**
 * Returns a de-escalation hint if the student has been struggling.
 *
 * Conditions for advice:
 * - At least 3 recent logs exist
 * - Average quality < 2.5
 * - Concept's bloomCeiling > 1 (there is a lower level to fall back to)
 */
export function getDeEscalationAdvice(conceptId: string): string | null {
  const concept = getConceptById(conceptId);
  if (!concept) return null;

  const recentLogs = getRecentActivityLogs(conceptId, 5);

  if (recentLogs.length < 3) return null;

  const avgQuality =
    recentLogs.reduce((sum, log) => sum + log.quality, 0) / recentLogs.length;

  if (avgQuality < 2.5 && (concept.bloomCeiling ?? 0) > 1) {
    return (
      `You've been finding "${concept.title}" difficult recently ` +
      `(average quality ${avgQuality.toFixed(1)}/5). ` +
      `Consider reviewing foundational activities at a lower Bloom level ` +
      `before pushing higher.`
    );
  }

  return null;
}

// ====================================================================
// getSynthesisOpportunities
// ====================================================================

/**
 * Detects synthesis opportunities across concepts with bloomCeiling >= 4.
 *
 * Priority (highest first):
 * 1. within-subdomain — 2+ concepts share a non-null subdomain (automatic=true)
 * 2. within-domain    — concepts span multiple subdomains in one domain (automatic=true)
 * 3. cross-domain     — concepts span multiple domains (automatic=false)
 */
export function getSynthesisOpportunities(
  domain?: string,
): SynthesisOpportunity[] {
  let concepts = getConceptsAboveBloomCeiling(4);

  if (domain) {
    concepts = concepts.filter((c) => c.domain === domain);
  }

  if (concepts.length < 2) return [];

  const opportunities: SynthesisOpportunity[] = [];
  const conceptSummaries = (ids: string[]) =>
    concepts
      .filter((c) => ids.includes(c.id))
      .map((c) => ({
        id: c.id,
        title: c.title,
        bloomCeiling: c.bloomCeiling ?? 0,
      }));

  // 1. within-subdomain: group by domain+subdomain (non-null subdomain)
  const subdomainGroups = new Map<string, typeof concepts>();
  for (const c of concepts) {
    if (c.subdomain == null) continue;
    const key = `${c.domain ?? ''}::${c.subdomain}`;
    if (!subdomainGroups.has(key)) subdomainGroups.set(key, []);
    subdomainGroups.get(key)!.push(c);
  }
  for (const [key, group] of subdomainGroups) {
    if (group.length < 2) continue;
    const [domainPart, subdomainPart] = key.split('::');
    opportunities.push({
      type: 'within-subdomain',
      domain: domainPart,
      subdomain: subdomainPart,
      concepts: conceptSummaries(group.map((c) => c.id)),
      automatic: true,
    });
  }

  // 2. within-domain: domains whose concepts span 2+ distinct subdomains
  const domainGroups = new Map<string, typeof concepts>();
  for (const c of concepts) {
    if (c.domain == null) continue;
    if (!domainGroups.has(c.domain)) domainGroups.set(c.domain, []);
    domainGroups.get(c.domain)!.push(c);
  }
  for (const [dom, group] of domainGroups) {
    const subdomains = new Set(group.map((c) => c.subdomain).filter(Boolean));
    if (subdomains.size < 2) continue;
    // Avoid duplicating a subdomain opportunity for the exact same concepts
    opportunities.push({
      type: 'within-domain',
      domain: dom,
      concepts: conceptSummaries(group.map((c) => c.id)),
      automatic: true,
    });
  }

  // 3. cross-domain: concepts span multiple distinct domains
  const distinctDomains = new Set(
    concepts.map((c) => c.domain).filter(Boolean),
  );
  if (distinctDomains.size >= 2) {
    // Use the first domain as the representative domain label
    const allDomains = [...distinctDomains];
    opportunities.push({
      type: 'cross-domain',
      domain: allDomains[0]!,
      concepts: conceptSummaries(concepts.map((c) => c.id)),
      automatic: false,
    });
  }

  return opportunities;
}
