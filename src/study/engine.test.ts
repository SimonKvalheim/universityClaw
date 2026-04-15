import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db/index.js';
import {
  createConcept,
  createActivity,
  createActivityLogEntry,
  type NewConcept,
  type NewLearningActivity,
  type NewActivityLogEntry,
} from './queries.js';
import {
  getConceptRecommendations,
  checkForAdvancement,
  processCompletion,
  getDeEscalationAdvice,
  getSynthesisOpportunities,
} from './engine.js';

// ============================================================
// Shared fixtures
// ============================================================

const NOW = '2026-04-15T12:00:00.000Z';
const TODAY = '2026-04-15';

function makeConcept(overrides: Partial<NewConcept> = {}): NewConcept {
  return {
    id: 'concept-1',
    title: 'Test Concept',
    createdAt: NOW,
    status: 'active',
    ...overrides,
  };
}

function makeActivity(
  overrides: Partial<NewLearningActivity> = {},
): NewLearningActivity {
  return {
    id: 'activity-1',
    conceptId: 'concept-1',
    activityType: 'card_review',
    prompt: 'What is test?',
    bloomLevel: 1,
    generatedAt: NOW,
    dueAt: TODAY,
    ...overrides,
  };
}

function makeLog(
  overrides: Partial<NewActivityLogEntry> = {},
): NewActivityLogEntry {
  return {
    id: 'log-1',
    activityId: 'activity-1',
    conceptId: 'concept-1',
    activityType: 'card_review',
    bloomLevel: 1,
    quality: 5,
    reviewedAt: NOW,
    ...overrides,
  };
}

// Helper: seed N log entries with the given quality at a bloom level
// to build up mastery evidence. Evidence = (quality/5) * decay per entry.
// For ceiling to reach `level`, each level L1..level needs evidence >= 7.0
// => 8 entries at quality=5 today gives 8.0 >= 7.0
function seedMasteryLogs(
  conceptId: string,
  activityId: string,
  bloomLevel: number,
  count: number,
  quality = 5,
): void {
  for (let i = 0; i < count; i++) {
    createActivityLogEntry(
      makeLog({
        id: `log-seed-${conceptId}-l${bloomLevel}-${i}`,
        activityId,
        conceptId,
        bloomLevel,
        quality,
        reviewedAt: NOW,
      }),
    );
  }
}

// ============================================================
// getConceptRecommendations
// ============================================================

describe('getConceptRecommendations', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('throws when concept is not found', () => {
    expect(() => getConceptRecommendations('does-not-exist')).toThrow();
  });

  it('bloomCeiling=0 (fresh): returns L1 card_review (count 3–5) + L2 elaboration (count 2)', () => {
    createConcept(makeConcept({ bloomCeiling: 0 }));
    const recs = getConceptRecommendations('concept-1');

    const cardRec = recs.find((r) => r.activityType === 'card_review');
    const elaborationRec = recs.find((r) => r.activityType === 'elaboration');

    expect(cardRec).toBeDefined();
    expect(cardRec!.bloomLevel).toBe(1);
    expect(cardRec!.count).toBeGreaterThanOrEqual(3);
    expect(cardRec!.count).toBeLessThanOrEqual(5);

    expect(elaborationRec).toBeDefined();
    expect(elaborationRec!.bloomLevel).toBe(2);
    expect(elaborationRec!.count).toBe(2);
  });

  it('bloomCeiling=2 (still low): returns L1 card_review + L2 elaboration', () => {
    createConcept(makeConcept({ bloomCeiling: 2 }));
    const recs = getConceptRecommendations('concept-1');

    expect(recs.find((r) => r.activityType === 'card_review')).toBeDefined();
    expect(recs.find((r) => r.activityType === 'elaboration')).toBeDefined();
    expect(recs.find((r) => r.activityType === 'synthesis')).toBeUndefined();
  });

  it('bloomCeiling=3: returns L3–L4 recommendations (self_explain, concept_map, comparison, case_analysis)', () => {
    createConcept(makeConcept({ bloomCeiling: 3 }));
    const recs = getConceptRecommendations('concept-1');

    const types = recs.map((r) => r.activityType);
    expect(types).toContain('self_explain');
    expect(types).toContain('concept_map');
    expect(types).toContain('comparison');
    expect(types).toContain('case_analysis');

    // All count 1
    for (const r of recs) {
      expect(r.count).toBe(1);
    }

    // Levels are 3 or 4
    for (const r of recs) {
      expect([3, 4]).toContain(r.bloomLevel);
    }

    // No low-level or high-level types
    expect(types).not.toContain('card_review');
    expect(types).not.toContain('synthesis');
  });

  it('bloomCeiling=4: returns L3–L4 recommendations', () => {
    createConcept(makeConcept({ bloomCeiling: 4 }));
    const recs = getConceptRecommendations('concept-1');
    const types = recs.map((r) => r.activityType);
    expect(types).toContain('self_explain');
    expect(types).toContain('concept_map');
    expect(types).not.toContain('synthesis');
  });

  it('bloomCeiling=5: returns L5–L6 recommendations (synthesis, socratic, case_analysis)', () => {
    createConcept(makeConcept({ bloomCeiling: 5 }));
    const recs = getConceptRecommendations('concept-1');

    const types = recs.map((r) => r.activityType);
    expect(types).toContain('synthesis');
    expect(types).toContain('socratic');
    expect(types).toContain('case_analysis');

    for (const r of recs) {
      expect(r.count).toBe(1);
    }

    // No low-level types
    expect(types).not.toContain('card_review');
    expect(types).not.toContain('elaboration');
  });

  it('bloomCeiling=6: returns L5–L6 recommendations', () => {
    createConcept(makeConcept({ bloomCeiling: 6 }));
    const recs = getConceptRecommendations('concept-1');
    const types = recs.map((r) => r.activityType);
    expect(types).toContain('synthesis');
    expect(types).toContain('socratic');
  });
});

// ============================================================
// checkForAdvancement
// ============================================================

describe('checkForAdvancement', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('returns null when concept has insufficient mastery evidence', () => {
    createConcept(makeConcept({ bloomCeiling: 0 }));
    createActivity(makeActivity());
    // Only 2 logs at L1 — not enough evidence (need >= 7.0, 2 * 1.0 = 2.0)
    seedMasteryLogs('concept-1', 'activity-1', 1, 2, 5);

    const result = checkForAdvancement('concept-1');
    expect(result).toBeNull();
  });

  it('returns BloomAdvancement with generationNeeded=true when mastery sufficient and no activities at new level', () => {
    // Setup: concept-1 has no LearningActivity rows. Logs are seeded using an activity
    // that belongs to a helper concept (activityId FK is to learningActivities table,
    // but conceptId in log is what getLogsByConceptAndLevel uses for grouping).
    createConcept(makeConcept({ id: 'concept-1', bloomCeiling: 0 }));
    createConcept(
      makeConcept({
        id: 'helper',
        title: 'Helper',
        bloomCeiling: 0,
        createdAt: NOW,
      }),
    );
    createActivity(
      makeActivity({
        id: 'activity-helper',
        conceptId: 'helper',
        bloomLevel: 1,
      }),
    );

    // Insert 8 logs attributed to concept-1 but using activity-helper's id for FK
    for (let i = 0; i < 8; i++) {
      createActivityLogEntry(
        makeLog({
          id: `log-gen-${i}`,
          activityId: 'activity-helper',
          conceptId: 'concept-1',
          bloomLevel: 1,
          quality: 5,
          reviewedAt: NOW,
        }),
      );
    }

    const result = checkForAdvancement('concept-1');
    expect(result).not.toBeNull();
    expect(result!.conceptId).toBe('concept-1');
    expect(result!.previousCeiling).toBe(0);
    expect(result!.newCeiling).toBe(1);
    // concept-1 has NO LearningActivity rows, so generationNeeded=true
    expect(result!.generationNeeded).toBe(true);
  });

  it('returns BloomAdvancement with generationNeeded=false when activities already exist at new level', () => {
    createConcept(makeConcept({ bloomCeiling: 0 }));
    createActivity(makeActivity({ id: 'activity-1', bloomLevel: 1 }));
    // Seed enough logs for ceiling to advance to 1 — activity at L1 already exists
    seedMasteryLogs('concept-1', 'activity-1', 1, 8, 5);

    const result = checkForAdvancement('concept-1');
    expect(result).not.toBeNull();
    // activity-1 is at bloomLevel=1 >= newCeiling=1, so generationNeeded=false
    expect(result!.generationNeeded).toBe(false);
  });
});

// ============================================================
// processCompletion
// ============================================================

describe('processCompletion', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('quality=5 with sufficient prior evidence: CompletionResult with advancement', () => {
    createConcept(makeConcept({ bloomCeiling: 0 }));
    createActivity(makeActivity({ id: 'activity-1', bloomLevel: 1 }));
    // Seed 7 prior logs (evidence = 7.0, just at threshold), then complete the 8th via processCompletion
    seedMasteryLogs('concept-1', 'activity-1', 1, 7, 5);

    const result = processCompletion({ activityId: 'activity-1', quality: 5 });
    expect(result.logEntryId).toBeDefined();
    expect(typeof result.newDueAt).toBe('string');
    expect(result.advancement).not.toBeNull();
    expect(result.advancement!.previousCeiling).toBe(0);
    expect(result.advancement!.newCeiling).toBeGreaterThan(0);
    // activity-1 at bloomLevel=1 already exists, so generationNeeded=false per spec
    expect(result.generationNeeded).toBe(false);
    expect(result.advancement!.generationNeeded).toBe(false);
  });

  it('quality=3, no prior evidence: no advancement', () => {
    createConcept(makeConcept({ bloomCeiling: 0 }));
    createActivity(makeActivity({ id: 'activity-1', bloomLevel: 1 }));

    const result = processCompletion({ activityId: 'activity-1', quality: 3 });
    expect(result.advancement).toBeNull();
    expect(result.generationNeeded).toBe(false);
  });

  it('repeated low quality: CompletionResult with deEscalation string when bloomCeiling > 1', () => {
    // bloomCeiling > 1 is required for de-escalation advice.
    // completeActivity recomputes bloomCeiling from all logs, so we must ensure
    // the concept has enough L1+L2 mastery to keep bloomCeiling > 1 after completion.
    createConcept(makeConcept({ bloomCeiling: 3 }));
    createActivity(makeActivity({ id: 'activity-l1', bloomLevel: 1 }));
    createActivity(makeActivity({ id: 'activity-l2', bloomLevel: 2 }));
    createActivity(makeActivity({ id: 'activity-l3', bloomLevel: 3 }));

    // Seed solid L1+L2 mastery — use NOW timestamps so decay is 1.0 and evidence
    // stays high (8.0 >= 7.0 threshold). These will be "older" in the ordering
    // because L3 logs below get timestamps slightly after NOW.
    for (let i = 0; i < 8; i++) {
      createActivityLogEntry(
        makeLog({ id: `log-l1-${i}`, activityId: 'activity-l1', bloomLevel: 1, quality: 5, reviewedAt: NOW }),
      );
      createActivityLogEntry(
        makeLog({ id: `log-l2-${i}`, activityId: 'activity-l2', bloomLevel: 2, quality: 5, reviewedAt: NOW }),
      );
    }

    // Seed 4 prior low-quality logs at L3 with timestamps after NOW so they appear
    // as the most recent in getRecentActivityLogs
    for (let i = 0; i < 4; i++) {
      createActivityLogEntry(
        makeLog({
          id: `log-low-${i}`,
          activityId: 'activity-l3',
          bloomLevel: 3,
          quality: 1,
          reviewedAt: `2026-04-15T13:0${i}:00.000Z`,
        }),
      );
    }

    // 5th completion via processCompletion with low quality (avg of last 5 = 1.0 < 2.5)
    // After completion, bloomCeiling is recomputed: L1 evidence=8.0, L2 evidence=8.0 => ceiling=2
    const result = processCompletion({ activityId: 'activity-l3', quality: 1 });
    expect(result.deEscalation).not.toBeNull();
    expect(typeof result.deEscalation).toBe('string');
  });

  it('throws when activity does not exist', () => {
    expect(() =>
      processCompletion({ activityId: 'no-such-activity', quality: 3 }),
    ).toThrow();
  });
});

// ============================================================
// getDeEscalationAdvice
// ============================================================

describe('getDeEscalationAdvice', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('returns null when fewer than 3 logs exist', () => {
    createConcept(makeConcept({ bloomCeiling: 2 }));
    createActivity(makeActivity());
    createActivityLogEntry(makeLog({ id: 'log-1', quality: 1 }));
    createActivityLogEntry(makeLog({ id: 'log-2', quality: 2 }));

    const result = getDeEscalationAdvice('concept-1');
    expect(result).toBeNull();
  });

  it('returns advice string when avg quality < 2.5 and bloomCeiling > 1', () => {
    createConcept(makeConcept({ bloomCeiling: 2 }));
    createActivity(makeActivity());
    for (let i = 0; i < 5; i++) {
      createActivityLogEntry(
        makeLog({ id: `log-low-${i}`, quality: 1, reviewedAt: NOW }),
      );
    }

    const result = getDeEscalationAdvice('concept-1');
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
  });

  it('returns null when avg quality >= 2.5', () => {
    createConcept(makeConcept({ bloomCeiling: 2 }));
    createActivity(makeActivity());
    for (let i = 0; i < 5; i++) {
      createActivityLogEntry(
        makeLog({ id: `log-high-${i}`, quality: 5, reviewedAt: NOW }),
      );
    }

    const result = getDeEscalationAdvice('concept-1');
    expect(result).toBeNull();
  });

  it('returns null when bloomCeiling <= 1 even if quality is low', () => {
    createConcept(makeConcept({ bloomCeiling: 1 }));
    createActivity(makeActivity());
    for (let i = 0; i < 5; i++) {
      createActivityLogEntry(
        makeLog({ id: `log-low-ceil1-${i}`, quality: 0, reviewedAt: NOW }),
      );
    }

    const result = getDeEscalationAdvice('concept-1');
    expect(result).toBeNull();
  });
});

// ============================================================
// getSynthesisOpportunities
// ============================================================

describe('getSynthesisOpportunities', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('returns empty array when no concepts are above ceiling 4', () => {
    createConcept(
      makeConcept({
        id: 'c-low',
        bloomCeiling: 3,
        status: 'active',
        domain: 'math',
        subdomain: 'algebra',
      }),
    );
    const result = getSynthesisOpportunities();
    expect(result).toHaveLength(0);
  });

  it('3 concepts in same subdomain with ceiling >= 4: 1 within-subdomain opportunity', () => {
    createConcept(
      makeConcept({
        id: 'c-1',
        title: 'C1',
        bloomCeiling: 4,
        status: 'active',
        domain: 'math',
        subdomain: 'algebra',
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-2',
        title: 'C2',
        bloomCeiling: 5,
        status: 'active',
        domain: 'math',
        subdomain: 'algebra',
        createdAt: NOW,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-3',
        title: 'C3',
        bloomCeiling: 4,
        status: 'active',
        domain: 'math',
        subdomain: 'algebra',
        createdAt: NOW,
      }),
    );

    const result = getSynthesisOpportunities();
    const subdomain = result.find((o) => o.type === 'within-subdomain');
    expect(subdomain).toBeDefined();
    expect(subdomain!.automatic).toBe(true);
    expect(subdomain!.subdomain).toBe('algebra');
    expect(subdomain!.concepts.length).toBeGreaterThanOrEqual(2);
  });

  it('concepts across subdomains within same domain: within-domain opportunity (automatic=true)', () => {
    createConcept(
      makeConcept({
        id: 'c-1',
        title: 'C1',
        bloomCeiling: 4,
        status: 'active',
        domain: 'math',
        subdomain: 'algebra',
        createdAt: NOW,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-2',
        title: 'C2',
        bloomCeiling: 4,
        status: 'active',
        domain: 'math',
        subdomain: 'calculus',
        createdAt: NOW,
      }),
    );

    const result = getSynthesisOpportunities();
    const domainOpp = result.find((o) => o.type === 'within-domain');
    expect(domainOpp).toBeDefined();
    expect(domainOpp!.automatic).toBe(true);
    expect(domainOpp!.domain).toBe('math');
  });

  it('domain filter: returns only opportunities matching that domain', () => {
    createConcept(
      makeConcept({
        id: 'c-math-1',
        title: 'Math1',
        bloomCeiling: 4,
        status: 'active',
        domain: 'math',
        subdomain: 'algebra',
        createdAt: NOW,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-math-2',
        title: 'Math2',
        bloomCeiling: 4,
        status: 'active',
        domain: 'math',
        subdomain: 'algebra',
        createdAt: NOW,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-phys-1',
        title: 'Phys1',
        bloomCeiling: 4,
        status: 'active',
        domain: 'physics',
        subdomain: 'mechanics',
        createdAt: NOW,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-phys-2',
        title: 'Phys2',
        bloomCeiling: 4,
        status: 'active',
        domain: 'physics',
        subdomain: 'mechanics',
        createdAt: NOW,
      }),
    );

    const result = getSynthesisOpportunities('math');
    expect(result.every((o) => o.domain === 'math')).toBe(true);
    expect(result.find((o) => o.domain === 'physics')).toBeUndefined();
  });

  it('cross-domain opportunity is automatic=false', () => {
    createConcept(
      makeConcept({
        id: 'c-math',
        title: 'Math',
        bloomCeiling: 5,
        status: 'active',
        domain: 'math',
        subdomain: 'algebra',
        createdAt: NOW,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-phys',
        title: 'Phys',
        bloomCeiling: 5,
        status: 'active',
        domain: 'physics',
        subdomain: 'mechanics',
        createdAt: NOW,
      }),
    );

    const result = getSynthesisOpportunities();
    const crossDomain = result.find((o) => o.type === 'cross-domain');
    expect(crossDomain).toBeDefined();
    expect(crossDomain!.automatic).toBe(false);
  });
});
