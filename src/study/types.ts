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

// === Forward-declared types for later sprints ===
// Stubs so downstream code can reference them. S3 will flesh these out.

/** Generator agent output (S3 will expand) */
export interface GeneratedActivity {
  activityType: ActivityType;
  prompt: string;
  referenceAnswer: string;
  bloomLevel: BloomLevel;
  cardType?: CardType;
  sourceNotePath?: string;
}

/** Session builder output (S3 will expand) */
export interface SessionComposition {
  sessionId: string;
  activities: Array<{
    activityId: string;
    block: 'new' | 'review' | 'stretch';
  }>;
  estimatedMinutes: number;
}

/** Bloom advancement check result (S3 will expand) */
export interface BloomAdvancement {
  conceptId: string;
  previousCeiling: number;
  newCeiling: number;
  generationNeeded: boolean;
}
