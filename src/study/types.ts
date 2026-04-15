// === Enums / Unions ===
// Values from spec Section 3.2 (activity types) and Section 3.1 (status fields)

/** Activity types — spec Section 3.2 */
export type ActivityType =
  | 'card_review'
  | 'elaboration'
  | 'self_explain'
  | 'concept_map'
  | 'comparison'
  | 'case_analysis'
  | 'synthesis'
  | 'socratic';

export type CardType = 'cloze' | 'basic' | 'reversed';
export type BloomLevel = 1 | 2 | 3 | 4 | 5 | 6;
export type MasteryState = 'new' | 'learning' | 'reviewing' | 'mastered';
export type EvaluationMethod = 'self_rated' | 'ai_rated' | 'hybrid';
export type SessionType = 'daily' | 'weekly' | 'monthly' | 'free';
export type PlanStrategy =
  | 'open'
  | 'exam-prep'
  | 'weekly-review'
  | 'exploration';
export type Surface = 'dashboard_chat' | 'dashboard_ui' | 'telegram';
export type ConceptStatus = 'pending' | 'active' | 'skipped' | 'archived';
export type ActivityAuthor = 'system' | 'student';

// === Algorithm I/O types ===

/** Per-Bloom's-level mastery evidence */
export interface MasteryLevels {
  L1: number;
  L2: number;
  L3: number;
  L4: number;
  L5: number;
  L6: number;
}

/** Full mastery computation result */
export interface MasteryResult {
  levels: MasteryLevels;
  overall: number; // 0.0 - 1.0
  bloomCeiling: number; // 0-6 (D3: highest mastered level, 0 = none)
}

/** Single activity log entry as mastery computation input */
export interface MasteryActivityInput {
  bloomLevel: BloomLevel;
  quality: number; // 0-5
  reviewedAt: string; // ISO datetime
}

// === S3 types ===

/** Generator agent output */
export interface GeneratedActivity {
  activityType: ActivityType;
  prompt: string;
  referenceAnswer: string;
  bloomLevel: BloomLevel;
  difficultyEstimate?: number;
  cardType?: CardType;
  sourceNotePath?: string;
  sourceChunkHash?: string;
  relatedConceptIds?: string[];
}

/** A block of activities within a session (new / review / stretch) */
export interface SessionBlock {
  type: 'new' | 'review' | 'stretch';
  activities: SessionActivity[];
}

/** A single schedulable activity within a session block */
export interface SessionActivity {
  activityId: string;
  conceptId: string;
  conceptTitle: string;
  domain: string | null;
  activityType: ActivityType;
  bloomLevel: BloomLevel;
}

/** Session builder output */
export interface SessionComposition {
  blocks: SessionBlock[];
  totalActivities: number;
  estimatedMinutes: number;
  domainsCovered: string[];
}

/** Options controlling session composition */
export interface SessionOptions {
  targetActivities?: number; // default 20
  domainFocus?: string; // filter to specific domain
}

/** Bloom advancement check result */
export interface BloomAdvancement {
  conceptId: string;
  conceptTitle: string;
  previousCeiling: number;
  newCeiling: number;
  generationNeeded: boolean;
}

/** Recommended activity mix for a concept */
export interface ActivityRecommendation {
  activityType: ActivityType;
  bloomLevel: BloomLevel;
  count: number;
}

/** Full result from completing an activity (engine-level) */
export interface CompletionResult {
  logEntryId: string;
  newDueAt: string;
  advancement: BloomAdvancement | null;
  generationNeeded: boolean;
  deEscalation: string | null;
}

/** A synthesis opportunity detected across concepts */
export interface SynthesisOpportunity {
  type: 'within-subdomain' | 'within-domain' | 'cross-domain';
  domain: string;
  subdomain?: string;
  concepts: Array<{ id: string; title: string; bloomCeiling: number }>;
  automatic: boolean; // true for within-subdomain/domain, false for cross-domain
}
