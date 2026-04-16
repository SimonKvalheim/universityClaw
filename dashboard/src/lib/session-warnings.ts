import * as fs from 'node:fs';
import * as path from 'node:path';
import { inArray } from 'drizzle-orm';
import { getDb } from './db/index';
import { concepts, concept_prerequisites } from './db/schema';

const WEAK_PREREQUISITE_THRESHOLD = 0.3;

export interface PrerequisiteWarning {
  conceptId: string;
  conceptTitle: string;
  weakPrerequisites: Array<{
    id: string;
    title: string;
    masteryOverall: number;
  }>;
}

export interface StalenessWarning {
  activityId: string;
  staleReason: 'source_deleted' | 'source_modified';
}

export function getPrerequisiteWarnings(conceptIds: string[]): PrerequisiteWarning[] {
  if (conceptIds.length === 0) return [];

  const db = getDb();

  // Fetch all prerequisite relationships for the given concept IDs
  const prereqRows = db
    .select()
    .from(concept_prerequisites)
    .where(inArray(concept_prerequisites.concept_id, conceptIds))
    .all();

  if (prereqRows.length === 0) return [];

  // Collect all unique prerequisite IDs to look up mastery
  const prereqIds = [...new Set(prereqRows.map((r) => r.prerequisite_id))];

  // Fetch concept details for both the session concepts and their prerequisites
  const allRelevantIds = [...new Set([...conceptIds, ...prereqIds])];
  const conceptRows = db
    .select({
      id: concepts.id,
      title: concepts.title,
      mastery_overall: concepts.mastery_overall,
    })
    .from(concepts)
    .where(inArray(concepts.id, allRelevantIds))
    .all();

  const conceptMap = new Map(conceptRows.map((c) => [c.id, c]));

  const warnings: PrerequisiteWarning[] = [];

  for (const conceptId of conceptIds) {
    const concept = conceptMap.get(conceptId);
    if (!concept) continue;

    const prereqIdsForConcept = prereqRows
      .filter((r) => r.concept_id === conceptId)
      .map((r) => r.prerequisite_id);

    const weakPrerequisites = prereqIdsForConcept
      .map((prereqId) => conceptMap.get(prereqId))
      .filter(
        (prereq): prereq is NonNullable<typeof prereq> =>
          prereq !== undefined &&
          (prereq.mastery_overall ?? 0) < WEAK_PREREQUISITE_THRESHOLD,
      )
      .map((prereq) => ({
        id: prereq.id,
        title: prereq.title,
        masteryOverall: prereq.mastery_overall ?? 0,
      }));

    if (weakPrerequisites.length > 0) {
      warnings.push({
        conceptId: concept.id,
        conceptTitle: concept.title,
        weakPrerequisites,
      });
    }
  }

  return warnings;
}

export function getStalenessWarnings(
  activities: Array<{
    activityId: string;
    sourceNotePath: string | null;
    generatedAt: string;
  }>,
): StalenessWarning[] {
  const vaultDir = process.env.VAULT_DIR || './vault';
  const warnings: StalenessWarning[] = [];

  for (const activity of activities) {
    if (!activity.sourceNotePath) continue;

    const absolutePath = path.resolve(vaultDir, activity.sourceNotePath);

    try {
      const stat = fs.statSync(absolutePath);
      const generatedAt = new Date(activity.generatedAt);
      if (stat.mtime > generatedAt) {
        warnings.push({
          activityId: activity.activityId,
          staleReason: 'source_modified',
        });
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        warnings.push({
          activityId: activity.activityId,
          staleReason: 'source_deleted',
        });
      }
      // Other errors: skip (treat as fresh)
    }
  }

  return warnings;
}
