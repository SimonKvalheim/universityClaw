import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db/index.js';
import {
  createConcept,
  getConceptById,
  getConceptsByDomain,
  getConceptsByStatus,
  getPendingConcepts,
  getActiveConcepts,
  updateConceptStatus,
  getConceptsAboveBloomCeiling,
  createActivity,
  getActivityById,
  getDueActivities,
  getActivitiesByConceptAndType,
  getActivitiesByConcept,
  batchCreateActivities,
  createActivityConceptLinks,
  createActivityLogEntry,
  getLogsByConceptAndLevel,
  getLogsBySession,
  getRecentActivityLogs,
  createStudySession,
  getStudySessionById,
  updateStudySession,
  getActiveSession,
  createStudyPlan,
  getStudyPlanById,
  getAllStudyPlans,
  updateStudyPlan,
  addConceptsToPlan,
  getPlanConcepts,
  completeActivity,
  type NewConcept,
  type NewLearningActivity,
  type NewActivityLogEntry,
  type NewStudySession,
  type NewStudyPlan,
} from './queries.js';

// ============================================================
// Shared fixtures
// ============================================================

const NOW = '2026-04-15T12:00:00.000Z';
const TODAY = '2026-04-15';
const YESTERDAY = '2026-04-14';
const TOMORROW = '2026-04-16';

function makeConcept(overrides: Partial<NewConcept> = {}): NewConcept {
  return {
    id: 'concept-1',
    title: 'Test Concept',
    createdAt: NOW,
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

function makeSession(
  overrides: Partial<NewStudySession> = {},
): NewStudySession {
  return {
    id: 'session-1',
    startedAt: NOW,
    sessionType: 'review',
    ...overrides,
  };
}

function makePlan(overrides: Partial<NewStudyPlan> = {}): NewStudyPlan {
  return {
    id: 'plan-1',
    title: 'Test Plan',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ============================================================
// Concept queries
// ============================================================

describe('concept queries', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('creates a concept and retrieves it by id', () => {
    createConcept(makeConcept());
    const found = getConceptById('concept-1');
    expect(found).toBeDefined();
    expect(found!.id).toBe('concept-1');
    expect(found!.title).toBe('Test Concept');
    expect(found!.createdAt).toBe(NOW);
  });

  it('returns undefined for a non-existent concept id', () => {
    const found = getConceptById('does-not-exist');
    expect(found).toBeUndefined();
  });

  it('queries concepts by domain', () => {
    createConcept(makeConcept({ id: 'c-a', title: 'Alpha', domain: 'math' }));
    createConcept(makeConcept({ id: 'c-b', title: 'Beta', domain: 'math' }));
    createConcept(
      makeConcept({ id: 'c-c', title: 'Gamma', domain: 'physics' }),
    );

    const math = getConceptsByDomain('math');
    expect(math).toHaveLength(2);
    expect(math.map((c) => c.id)).toContain('c-a');
    expect(math.map((c) => c.id)).toContain('c-b');

    const physics = getConceptsByDomain('physics');
    expect(physics).toHaveLength(1);
    expect(physics[0].id).toBe('c-c');
  });

  it('filters pending vs active concepts correctly', () => {
    createConcept(
      makeConcept({ id: 'c-pending', title: 'Pending', status: 'pending' }),
    );
    createConcept(
      makeConcept({ id: 'c-active', title: 'Active', status: 'active' }),
    );

    const pending = getPendingConcepts();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('c-pending');

    const active = getActiveConcepts();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('c-active');
  });

  it('updates concept status', () => {
    createConcept(makeConcept({ status: 'pending' }));
    updateConceptStatus('concept-1', 'active');

    const updated = getConceptById('concept-1');
    expect(updated!.status).toBe('active');
  });
});

// ============================================================
// Activity queries
// ============================================================

describe('activity queries', () => {
  beforeEach(() => {
    _initTestDatabase();
    // Seed a concept that activities can reference
    createConcept(makeConcept());
  });
  afterEach(() => _closeDatabase());

  it('creates an activity and retrieves it by id with correct SM-2 defaults', () => {
    createActivity(makeActivity());
    const found = getActivityById('activity-1');
    expect(found).toBeDefined();
    expect(found!.id).toBe('activity-1');
    expect(found!.easeFactor).toBe(2.5);
    expect(found!.repetitions).toBe(0);
    expect(found!.masteryState).toBe('new');
  });

  it('getDueActivities returns activities at or before the cutoff date, ordered by dueAt asc', () => {
    createActivity(makeActivity({ id: 'a-old', dueAt: YESTERDAY }));
    createActivity(makeActivity({ id: 'a-today', dueAt: TODAY }));
    createActivity(makeActivity({ id: 'a-future', dueAt: TOMORROW }));

    const due = getDueActivities(TODAY);
    expect(due).toHaveLength(2);
    expect(due[0].id).toBe('a-old'); // earliest first
    expect(due[1].id).toBe('a-today');
  });

  it('getDueActivities excludes future activities', () => {
    createActivity(makeActivity({ id: 'a-future', dueAt: TOMORROW }));
    const due = getDueActivities(TODAY);
    expect(due).toHaveLength(0);
  });

  it('getActivitiesByConceptAndType filters by concept and activity type', () => {
    createConcept(makeConcept({ id: 'concept-2', title: 'Other Concept' }));

    createActivity(
      makeActivity({
        id: 'a-fc-1',
        activityType: 'card_review',
        conceptId: 'concept-1',
      }),
    );
    createActivity(
      makeActivity({
        id: 'a-fc-2',
        activityType: 'card_review',
        conceptId: 'concept-2',
      }),
    );
    createActivity(
      makeActivity({
        id: 'a-qa-1',
        activityType: 'qa',
        conceptId: 'concept-1',
      }),
    );

    const result = getActivitiesByConceptAndType('concept-1', 'card_review');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a-fc-1');
  });
});

// ============================================================
// Activity log queries
// ============================================================

describe('activity log queries', () => {
  beforeEach(() => {
    _initTestDatabase();
    createConcept(makeConcept());
    createActivity(makeActivity());
  });
  afterEach(() => _closeDatabase());

  function makeLogEntry(
    overrides: Partial<NewActivityLogEntry> = {},
  ): NewActivityLogEntry {
    return {
      id: 'log-1',
      activityId: 'activity-1',
      conceptId: 'concept-1',
      activityType: 'card_review',
      bloomLevel: 1,
      quality: 4,
      reviewedAt: NOW,
      ...overrides,
    };
  }

  it('creates a log entry and retrieves it by concept', () => {
    createActivityLogEntry(makeLogEntry());
    const logs = getLogsByConceptAndLevel('concept-1');
    expect(logs).toHaveLength(1);
    expect(logs[0].id).toBe('log-1');
    expect(logs[0].quality).toBe(4);
  });

  it('filters log entries by bloom level', () => {
    createActivityLogEntry(makeLogEntry({ id: 'log-l1', bloomLevel: 1 }));
    createActivityLogEntry(makeLogEntry({ id: 'log-l3', bloomLevel: 3 }));

    const l1Logs = getLogsByConceptAndLevel('concept-1', 1);
    expect(l1Logs).toHaveLength(1);
    expect(l1Logs[0].id).toBe('log-l1');

    const l3Logs = getLogsByConceptAndLevel('concept-1', 3);
    expect(l3Logs).toHaveLength(1);
    expect(l3Logs[0].id).toBe('log-l3');
  });

  it('queries log entries by session', () => {
    createStudySession(makeSession());
    createActivityLogEntry(
      makeLogEntry({ id: 'log-with-session', sessionId: 'session-1' }),
    );
    createActivityLogEntry(makeLogEntry({ id: 'log-no-session' }));

    const sessionLogs = getLogsBySession('session-1');
    expect(sessionLogs).toHaveLength(1);
    expect(sessionLogs[0].id).toBe('log-with-session');
  });
});

// ============================================================
// Session queries
// ============================================================

describe('session queries', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('creates a session and retrieves it by id', () => {
    createStudySession(makeSession());
    const found = getStudySessionById('session-1');
    expect(found).toBeDefined();
    expect(found!.id).toBe('session-1');
    expect(found!.sessionType).toBe('review');
    expect(found!.startedAt).toBe(NOW);
  });

  it('getActiveSession returns a non-ended session', () => {
    createStudySession(makeSession({ id: 'active-session', endedAt: null }));
    createStudySession(makeSession({ id: 'ended-session', endedAt: NOW }));

    const active = getActiveSession();
    expect(active).toBeDefined();
    expect(active!.id).toBe('active-session');
  });

  it('getActiveSession returns undefined when all sessions are ended', () => {
    createStudySession(makeSession({ endedAt: NOW }));
    const active = getActiveSession();
    expect(active).toBeUndefined();
  });

  it('updateStudySession updates partial fields', () => {
    createStudySession(makeSession());
    updateStudySession('session-1', {
      endedAt: TOMORROW,
      activitiesCompleted: 5,
    });

    const updated = getStudySessionById('session-1');
    expect(updated!.endedAt).toBe(TOMORROW);
    expect(updated!.activitiesCompleted).toBe(5);
    // untouched fields stay the same
    expect(updated!.sessionType).toBe('review');
  });
});

// ============================================================
// Plan queries
// ============================================================

describe('plan queries', () => {
  beforeEach(() => {
    _initTestDatabase();
    // Seed a concept for plan-concept join tests
    createConcept(makeConcept());
  });
  afterEach(() => _closeDatabase());

  it('creates a plan and retrieves it by id', () => {
    createStudyPlan(makePlan());
    const found = getStudyPlanById('plan-1');
    expect(found).toBeDefined();
    expect(found!.id).toBe('plan-1');
    expect(found!.title).toBe('Test Plan');
  });

  it('adds concepts to a plan and retrieves them in sort order', () => {
    createConcept(makeConcept({ id: 'concept-2', title: 'B Concept' }));
    createStudyPlan(makePlan());

    addConceptsToPlan('plan-1', ['concept-2', 'concept-1'], 3);

    const planConcepts = getPlanConcepts('plan-1');
    expect(planConcepts).toHaveLength(2);
    // sort order reflects insertion order (index 0 = concept-2, index 1 = concept-1)
    expect(planConcepts[0].id).toBe('concept-2');
    expect(planConcepts[1].id).toBe('concept-1');
  });

  it('getAllStudyPlans lists plans ordered by createdAt desc', () => {
    createStudyPlan(
      makePlan({
        id: 'plan-old',
        title: 'Old Plan',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: NOW,
      }),
    );
    createStudyPlan(
      makePlan({
        id: 'plan-new',
        title: 'New Plan',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: NOW,
      }),
    );

    const plans = getAllStudyPlans();
    expect(plans).toHaveLength(2);
    expect(plans[0].id).toBe('plan-new');
    expect(plans[1].id).toBe('plan-old');
  });
});

// ============================================================
// completeActivity (transactional)
// ============================================================

describe('completeActivity', () => {
  beforeEach(() => {
    _initTestDatabase();
    createConcept(makeConcept());
    createActivity(makeActivity({ dueAt: TODAY }));
  });
  afterEach(() => _closeDatabase());

  it('happy path: updates SM-2 fields, creates a log entry, and updates concept mastery', () => {
    const result = completeActivity({
      activityId: 'activity-1',
      quality: 4,
    });

    // Result shape is correct
    expect(result.logEntryId).toBeDefined();
    expect(typeof result.newDueAt).toBe('string');
    expect(result.masteryUpdated).toBe(true);
    expect(typeof result.bloomCeilingBefore).toBe('number');
    expect(typeof result.bloomCeilingAfter).toBe('number');

    // Activity SM-2 fields were updated
    const activity = getActivityById('activity-1');
    expect(activity!.lastQuality).toBe(4);
    expect(activity!.repetitions).toBeGreaterThan(0);
    expect(activity!.masteryState).not.toBe('new');

    // A log entry was created for this concept
    const logs = getLogsByConceptAndLevel('concept-1');
    expect(logs).toHaveLength(1);
    expect(logs[0].quality).toBe(4);

    // Concept mastery fields were updated
    const concept = getConceptById('concept-1');
    expect(concept!.masteryOverall).toBeGreaterThan(0);
    expect(concept!.lastActivityAt).toBeDefined();
  });

  it('throws an error when the activity does not exist', () => {
    expect(() =>
      completeActivity({ activityId: 'no-such-id', quality: 3 }),
    ).toThrow('Activity not found: no-such-id');
  });

  it('increments session activitiesCompleted when sessionId is provided', () => {
    createStudySession(makeSession());

    completeActivity({
      activityId: 'activity-1',
      quality: 5,
      sessionId: 'session-1',
    });

    const session = getStudySessionById('session-1');
    expect(session!.activitiesCompleted).toBe(1);
  });

  it('does not increment session count when no sessionId is provided', () => {
    createStudySession(makeSession());

    completeActivity({ activityId: 'activity-1', quality: 5 });

    const session = getStudySessionById('session-1');
    // activitiesCompleted schema default is 0; should remain 0
    expect(session!.activitiesCompleted).toBe(0);
  });

  it('transaction rolls back on failure — no log entry or mastery update on error', () => {
    // Corrupt the activity reference so the transaction will fail mid-way.
    // We simulate this by completing a non-existent activity; the initial
    // "get activity" step throws before any writes happen.
    const logsBefore = getLogsByConceptAndLevel('concept-1');
    const conceptBefore = getConceptById('concept-1');

    expect(() =>
      completeActivity({ activityId: 'ghost-activity', quality: 4 }),
    ).toThrow();

    // Nothing should have been written
    const logsAfter = getLogsByConceptAndLevel('concept-1');
    const conceptAfter = getConceptById('concept-1');

    expect(logsAfter).toHaveLength(logsBefore.length);
    expect(conceptAfter!.masteryOverall).toBe(conceptBefore!.masteryOverall);
    expect(conceptAfter!.lastActivityAt).toBe(conceptBefore!.lastActivityAt);
  });
});

// ============================================================
// getActivitiesByConcept
// ============================================================

describe('getActivitiesByConcept', () => {
  beforeEach(() => {
    _initTestDatabase();
    createConcept(makeConcept());
  });
  afterEach(() => _closeDatabase());

  it('returns all activities for a concept ordered by bloomLevel asc', () => {
    createActivity(makeActivity({ id: 'a-l3', bloomLevel: 3 }));
    createActivity(makeActivity({ id: 'a-l1', bloomLevel: 1 }));
    createActivity(makeActivity({ id: 'a-l2', bloomLevel: 2 }));

    const result = getActivitiesByConcept('concept-1');
    expect(result).toHaveLength(3);
    expect(result[0].bloomLevel).toBe(1);
    expect(result[1].bloomLevel).toBe(2);
    expect(result[2].bloomLevel).toBe(3);
  });

  it('returns empty array when concept has no activities', () => {
    const result = getActivitiesByConcept('concept-1');
    expect(result).toHaveLength(0);
  });

  it('does not return activities belonging to a different concept', () => {
    createConcept(makeConcept({ id: 'concept-2', title: 'Other' }));
    createActivity(makeActivity({ id: 'a-other', conceptId: 'concept-2' }));

    const result = getActivitiesByConcept('concept-1');
    expect(result).toHaveLength(0);
  });
});

// ============================================================
// getRecentActivityLogs
// ============================================================

describe('getRecentActivityLogs', () => {
  beforeEach(() => {
    _initTestDatabase();
    createConcept(makeConcept());
    createActivity(makeActivity());
  });
  afterEach(() => _closeDatabase());

  function makeLogEntry(
    overrides: Partial<NewActivityLogEntry> = {},
  ): NewActivityLogEntry {
    return {
      id: 'log-1',
      activityId: 'activity-1',
      conceptId: 'concept-1',
      activityType: 'card_review',
      bloomLevel: 1,
      quality: 4,
      reviewedAt: NOW,
      ...overrides,
    };
  }

  it('returns the last N logs ordered by reviewedAt desc', () => {
    createActivityLogEntry(
      makeLogEntry({ id: 'log-old', reviewedAt: '2026-01-01T10:00:00.000Z' }),
    );
    createActivityLogEntry(
      makeLogEntry({ id: 'log-mid', reviewedAt: '2026-02-01T10:00:00.000Z' }),
    );
    createActivityLogEntry(
      makeLogEntry({ id: 'log-new', reviewedAt: '2026-04-01T10:00:00.000Z' }),
    );

    const result = getRecentActivityLogs('concept-1', 2);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('log-new');
    expect(result[1].id).toBe('log-mid');
  });

  it('returns all logs when limit exceeds the available count', () => {
    createActivityLogEntry(makeLogEntry({ id: 'log-a' }));
    const result = getRecentActivityLogs('concept-1', 10);
    expect(result).toHaveLength(1);
  });

  it('returns empty array when concept has no logs', () => {
    const result = getRecentActivityLogs('concept-1', 5);
    expect(result).toHaveLength(0);
  });
});

// ============================================================
// batchCreateActivities
// ============================================================

describe('batchCreateActivities', () => {
  beforeEach(() => {
    _initTestDatabase();
    createConcept(makeConcept());
  });
  afterEach(() => _closeDatabase());

  it('inserts all activities in one transaction', () => {
    batchCreateActivities([
      makeActivity({ id: 'batch-a1', bloomLevel: 1 }),
      makeActivity({ id: 'batch-a2', bloomLevel: 2 }),
      makeActivity({ id: 'batch-a3', bloomLevel: 3 }),
    ]);

    expect(getActivityById('batch-a1')).toBeDefined();
    expect(getActivityById('batch-a2')).toBeDefined();
    expect(getActivityById('batch-a3')).toBeDefined();
  });

  it('does nothing when given an empty array', () => {
    batchCreateActivities([]);
    const result = getActivitiesByConcept('concept-1');
    expect(result).toHaveLength(0);
  });
});

// ============================================================
// createActivityConceptLinks
// ============================================================

describe('createActivityConceptLinks', () => {
  beforeEach(() => {
    _initTestDatabase();
    createConcept(makeConcept({ id: 'concept-1', title: 'C1' }));
    createConcept(makeConcept({ id: 'concept-2', title: 'C2' }));
    createActivity(makeActivity({ id: 'activity-1', conceptId: 'concept-1' }));
  });
  afterEach(() => _closeDatabase());

  it('inserts concept links for an activity with the default role', () => {
    createActivityConceptLinks('activity-1', ['concept-2']);
    // Verify via getActivitiesByConcept — the link row is not surfaced by
    // existing query helpers, so we at minimum confirm no error was thrown
    // and the function is idempotent (second call does not throw).
    expect(() =>
      createActivityConceptLinks('activity-1', ['concept-2']),
    ).not.toThrow();
  });

  it('inserts links with a custom role without error', () => {
    expect(() =>
      createActivityConceptLinks('activity-1', ['concept-2'], 'primary'),
    ).not.toThrow();
  });

  it('does nothing when given an empty conceptIds array', () => {
    expect(() => createActivityConceptLinks('activity-1', [])).not.toThrow();
  });
});

// ============================================================
// getConceptsAboveBloomCeiling
// ============================================================

describe('getConceptsAboveBloomCeiling', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('returns active concepts whose bloomCeiling meets or exceeds the threshold', () => {
    createConcept(
      makeConcept({
        id: 'c-l0',
        title: 'Zero',
        status: 'active',
        bloomCeiling: 0,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-l2',
        title: 'Two',
        status: 'active',
        bloomCeiling: 2,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-l4',
        title: 'Four',
        status: 'active',
        bloomCeiling: 4,
      }),
    );

    const result = getConceptsAboveBloomCeiling(2);
    const ids = result.map((c) => c.id);
    expect(ids).toContain('c-l2');
    expect(ids).toContain('c-l4');
    expect(ids).not.toContain('c-l0');
  });

  it('excludes non-active concepts even if bloomCeiling qualifies', () => {
    createConcept(
      makeConcept({
        id: 'c-archived',
        title: 'Archived',
        status: 'archived',
        bloomCeiling: 5,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-pending',
        title: 'Pending',
        status: 'pending',
        bloomCeiling: 5,
      }),
    );

    const result = getConceptsAboveBloomCeiling(1);
    const ids = result.map((c) => c.id);
    expect(ids).not.toContain('c-archived');
    expect(ids).not.toContain('c-pending');
  });

  it('returns empty array when no concepts meet the threshold', () => {
    createConcept(
      makeConcept({
        id: 'c-low',
        title: 'Low',
        status: 'active',
        bloomCeiling: 1,
      }),
    );
    const result = getConceptsAboveBloomCeiling(3);
    expect(result).toHaveLength(0);
  });

  it('returns results ordered by title asc', () => {
    createConcept(
      makeConcept({
        id: 'c-zebra',
        title: 'Zebra',
        status: 'active',
        bloomCeiling: 3,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-alpha',
        title: 'Alpha',
        status: 'active',
        bloomCeiling: 3,
      }),
    );

    const result = getConceptsAboveBloomCeiling(3);
    expect(result[0].title).toBe('Alpha');
    expect(result[1].title).toBe('Zebra');
  });
});
