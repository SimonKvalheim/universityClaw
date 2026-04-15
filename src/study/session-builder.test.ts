import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db/index.js';
import {
  createConcept,
  createActivity,
  type NewConcept,
  type NewLearningActivity,
} from './queries.js';
import { buildDailySession } from './session-builder.js';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildDailySession', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  // ──────────────────────────────────────────────────────────────────────────
  // 1. No due activities → empty composition
  // ──────────────────────────────────────────────────────────────────────────
  it('returns empty composition when no activities are due', async () => {
    const result = await buildDailySession();
    expect(result.totalActivities).toBe(0);
    expect(result.estimatedMinutes).toBe(0);
    expect(result.blocks).toHaveLength(0);
    expect(result.domainsCovered).toHaveLength(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. All three blocks populated
  // ──────────────────────────────────────────────────────────────────────────
  it('populates new, review, and stretch blocks when activities are available', async () => {
    // Concept ceiling < 3 for new block, ceiling 2 for review, ceiling >= 4 for stretch
    createConcept(
      makeConcept({ id: 'c-new', title: 'New Concept', bloomCeiling: 2 }),
    );
    createConcept(
      makeConcept({ id: 'c-rev', title: 'Review Concept', bloomCeiling: 2 }),
    );
    createConcept(
      makeConcept({ id: 'c-str', title: 'Stretch Concept', bloomCeiling: 5 }),
    );

    // 5 new L1 activities (bloomLevel 1, concept ceiling < 3)
    for (let i = 1; i <= 5; i++) {
      createActivity(
        makeActivity({ id: `new-${i}`, conceptId: 'c-new', bloomLevel: 1 }),
      );
    }
    // 10 review activities (not L1-2 with ceiling < 3 — use bloomLevel 3)
    for (let i = 1; i <= 10; i++) {
      createActivity(
        makeActivity({
          id: `rev-${i}`,
          conceptId: 'c-rev',
          bloomLevel: 3,
          activityType: 'elaboration',
        }),
      );
    }
    // 3 stretch L5 activities (bloomLevel >= 4, concept ceiling >= 4)
    for (let i = 1; i <= 3; i++) {
      createActivity(
        makeActivity({
          id: `str-${i}`,
          conceptId: 'c-str',
          bloomLevel: 5,
          activityType: 'synthesis',
        }),
      );
    }

    const result = await buildDailySession({ targetActivities: 20 });

    expect(result.totalActivities).toBeGreaterThan(0);
    expect(result.blocks.length).toBeGreaterThan(0);

    const newBlock = result.blocks.find((b) => b.type === 'new');
    const reviewBlock = result.blocks.find((b) => b.type === 'review');
    const stretchBlock = result.blocks.find((b) => b.type === 'stretch');

    // New block should have some activities (up to 30% of 20 = 6, capped at 5 available)
    expect(newBlock).toBeDefined();
    expect(newBlock!.activities.length).toBeGreaterThan(0);

    // Review block should have some activities
    expect(reviewBlock).toBeDefined();
    expect(reviewBlock!.activities.length).toBeGreaterThan(0);

    // Stretch block should have some activities
    expect(stretchBlock).toBeDefined();
    expect(stretchBlock!.activities.length).toBeGreaterThan(0);

    // Total should not exceed target
    expect(result.totalActivities).toBeLessThanOrEqual(20);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Only review block (no new material, no stretch)
  // ──────────────────────────────────────────────────────────────────────────
  it('places all activities in review block when concepts ceiling < 3 and bloomLevel not 1-2', async () => {
    // bloomCeiling = 2, but activities at bloomLevel 3 → not "new material" eligible
    createConcept(
      makeConcept({ id: 'c-rev', title: 'Review Concept', bloomCeiling: 2 }),
    );

    for (let i = 1; i <= 15; i++) {
      createActivity(
        makeActivity({
          id: `rev-${i}`,
          conceptId: 'c-rev',
          bloomLevel: 3,
          activityType: 'elaboration',
        }),
      );
    }

    const result = await buildDailySession({ targetActivities: 20 });

    const newBlock = result.blocks.find((b) => b.type === 'new');
    const reviewBlock = result.blocks.find((b) => b.type === 'review');
    const stretchBlock = result.blocks.find((b) => b.type === 'stretch');

    expect(newBlock?.activities ?? []).toHaveLength(0);
    expect(stretchBlock?.activities ?? []).toHaveLength(0);
    expect(reviewBlock).toBeDefined();
    expect(reviewBlock!.activities.length).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Domain focus filter
  // ──────────────────────────────────────────────────────────────────────────
  it('filters to only activities from the focused domain', async () => {
    createConcept(
      makeConcept({
        id: 'c-math',
        title: 'Math',
        domain: 'math',
        bloomCeiling: 2,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-phys',
        title: 'Physics',
        domain: 'physics',
        bloomCeiling: 2,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-bio',
        title: 'Biology',
        domain: 'biology',
        bloomCeiling: 2,
      }),
    );

    for (let i = 1; i <= 5; i++) {
      createActivity(
        makeActivity({ id: `math-${i}`, conceptId: 'c-math', bloomLevel: 3 }),
      );
    }
    for (let i = 1; i <= 5; i++) {
      createActivity(
        makeActivity({ id: `phys-${i}`, conceptId: 'c-phys', bloomLevel: 3 }),
      );
    }
    for (let i = 1; i <= 5; i++) {
      createActivity(
        makeActivity({ id: `bio-${i}`, conceptId: 'c-bio', bloomLevel: 3 }),
      );
    }

    const result = await buildDailySession({ domainFocus: 'math' });

    const allActivities = result.blocks.flatMap((b) => b.activities);
    expect(allActivities.length).toBeGreaterThan(0);

    for (const act of allActivities) {
      expect(act.domain).toBe('math');
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Interleaving: no consecutive same-concept in review block
  // ──────────────────────────────────────────────────────────────────────────
  it('interleaves review activities so no two consecutive share the same conceptId', async () => {
    // 5 concepts, 2 activities each = 10 total
    for (let c = 1; c <= 5; c++) {
      createConcept(
        makeConcept({ id: `c-${c}`, title: `Concept ${c}`, bloomCeiling: 2 }),
      );
      for (let a = 1; a <= 2; a++) {
        createActivity(
          makeActivity({
            id: `c${c}-a${a}`,
            conceptId: `c-${c}`,
            bloomLevel: 3,
            activityType: 'elaboration',
          }),
        );
      }
    }

    const result = await buildDailySession({ targetActivities: 20 });
    const reviewBlock = result.blocks.find((b) => b.type === 'review');
    expect(reviewBlock).toBeDefined();

    const activities = reviewBlock!.activities;
    // The first activities (before any tail stacking) should not have consecutive same-concept
    // We check only up to the point where all concepts have been exhausted (first 5 slots at least)
    for (let i = 1; i < Math.min(activities.length, 5); i++) {
      expect(activities[i].conceptId).not.toBe(activities[i - 1].conceptId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. New block is grouped by domain (topic coherence)
  // ──────────────────────────────────────────────────────────────────────────
  it('groups new block activities by domain for topic coherence', async () => {
    createConcept(
      makeConcept({
        id: 'c-a',
        title: 'Domain A Concept',
        domain: 'domain-a',
        bloomCeiling: 2,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-b',
        title: 'Domain B Concept',
        domain: 'domain-b',
        bloomCeiling: 2,
      }),
    );

    // 3 activities per domain at bloomLevel 1
    for (let i = 1; i <= 3; i++) {
      createActivity(
        makeActivity({ id: `a-${i}`, conceptId: 'c-a', bloomLevel: 1 }),
      );
    }
    for (let i = 1; i <= 3; i++) {
      createActivity(
        makeActivity({ id: `b-${i}`, conceptId: 'c-b', bloomLevel: 1 }),
      );
    }

    const result = await buildDailySession({ targetActivities: 20 });
    const newBlock = result.blocks.find((b) => b.type === 'new');
    expect(newBlock).toBeDefined();
    expect(newBlock!.activities.length).toBeGreaterThan(0);

    // Verify activities are grouped: all domain-a come before all domain-b or vice versa
    const domains = newBlock!.activities.map((a) => a.domain);
    let lastDomain: string | null | undefined = undefined;
    let switchCount = 0;
    for (const d of domains) {
      if (d !== lastDomain) {
        if (lastDomain !== undefined) switchCount++;
        lastDomain = d;
      }
    }
    // With only 2 domains and grouped ordering, there should be at most 1 domain switch
    expect(switchCount).toBeLessThanOrEqual(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Stretch requires concept bloomCeiling >= 4
  // ──────────────────────────────────────────────────────────────────────────
  it('produces no stretch activities when all concept ceilings are below 4', async () => {
    createConcept(
      makeConcept({ id: 'c-low2', title: 'Low2', bloomCeiling: 2 }),
    );
    createConcept(
      makeConcept({ id: 'c-low3', title: 'Low3', bloomCeiling: 3 }),
    );

    for (let i = 1; i <= 5; i++) {
      createActivity(
        makeActivity({
          id: `l2-${i}`,
          conceptId: 'c-low2',
          bloomLevel: 4,
          activityType: 'synthesis',
        }),
      );
    }
    for (let i = 1; i <= 5; i++) {
      createActivity(
        makeActivity({
          id: `l3-${i}`,
          conceptId: 'c-low3',
          bloomLevel: 5,
          activityType: 'synthesis',
        }),
      );
    }

    const result = await buildDailySession({ targetActivities: 20 });
    const stretchBlock = result.blocks.find((b) => b.type === 'stretch');
    expect(stretchBlock?.activities ?? []).toHaveLength(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Target cap — session should not exceed targetActivities
  // ──────────────────────────────────────────────────────────────────────────
  it('caps total activities at targetActivities', async () => {
    createConcept(makeConcept({ id: 'c-1', title: 'C1', bloomCeiling: 2 }));

    for (let i = 1; i <= 30; i++) {
      createActivity(
        makeActivity({
          id: `act-${i}`,
          conceptId: 'c-1',
          bloomLevel: 3,
          activityType: 'elaboration',
        }),
      );
    }

    const result = await buildDailySession({ targetActivities: 15 });
    expect(result.totalActivities).toBeLessThanOrEqual(15);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 9. Time estimate accuracy
  // ──────────────────────────────────────────────────────────────────────────
  it('computes correct estimatedMinutes based on activity types', async () => {
    createConcept(makeConcept({ id: 'c-1', title: 'C1', bloomCeiling: 2 }));
    createConcept(makeConcept({ id: 'c-2', title: 'C2', bloomCeiling: 5 }));

    // 4 card_review @ 1.5 min each = 6 min
    for (let i = 1; i <= 4; i++) {
      createActivity(
        makeActivity({
          id: `cr-${i}`,
          conceptId: 'c-1',
          bloomLevel: 3,
          activityType: 'card_review',
        }),
      );
    }
    // 2 synthesis @ 7 min each = 14 min
    for (let i = 1; i <= 2; i++) {
      createActivity(
        makeActivity({
          id: `syn-${i}`,
          conceptId: 'c-2',
          bloomLevel: 5,
          activityType: 'synthesis',
        }),
      );
    }

    // Force only these activity types into the result by using a small target
    const result = await buildDailySession({ targetActivities: 6 });

    // Expected total: depends on which activities are placed, but estimate must match placed types
    let expectedMinutes = 0;
    for (const block of result.blocks) {
      for (const act of block.activities) {
        if (act.activityType === 'card_review') expectedMinutes += 1.5;
        else if (act.activityType === 'elaboration') expectedMinutes += 3;
        else if (
          act.activityType === 'self_explain' ||
          act.activityType === 'comparison' ||
          act.activityType === 'case_analysis' ||
          act.activityType === 'concept_map'
        )
          expectedMinutes += 5;
        else if (
          act.activityType === 'synthesis' ||
          act.activityType === 'socratic'
        )
          expectedMinutes += 7;
      }
    }

    expect(result.estimatedMinutes).toBeCloseTo(expectedMinutes, 5);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 10. Missing concept silently skipped
  // ──────────────────────────────────────────────────────────────────────────
  it('silently skips activities whose concept is archived (not active)', async () => {
    // Active concept — activities should be included
    createConcept(
      makeConcept({
        id: 'c-real',
        title: 'Real Concept',
        status: 'active',
        bloomCeiling: 2,
      }),
    );
    // Archived concept — activities for this concept should be skipped by the builder
    createConcept(
      makeConcept({
        id: 'c-archived',
        title: 'Archived Concept',
        status: 'archived',
        bloomCeiling: 2,
      }),
    );

    createActivity(
      makeActivity({ id: 'act-real', conceptId: 'c-real', bloomLevel: 3 }),
    );
    createActivity(
      makeActivity({
        id: 'act-archived',
        conceptId: 'c-archived',
        bloomLevel: 3,
      }),
    );

    let result: ReturnType<typeof buildDailySession> | undefined;
    await expect(async () => {
      result = await buildDailySession();
    }).not.toThrow();

    const allActivities = result!.blocks.flatMap((b) => b.activities);
    // Archived concept's activity is excluded
    expect(allActivities.every((a) => a.conceptId !== 'c-archived')).toBe(true);
    // The real activity is still included
    expect(allActivities.some((a) => a.activityId === 'act-real')).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 11. Domain coverage: missing domain is swapped in
  // ──────────────────────────────────────────────────────────────────────────
  it('ensures all active domains with due activities are represented in the session', async () => {
    // 3 domains
    createConcept(
      makeConcept({ id: 'c-a', title: 'A', domain: 'alpha', bloomCeiling: 2 }),
    );
    createConcept(
      makeConcept({ id: 'c-b', title: 'B', domain: 'beta', bloomCeiling: 2 }),
    );
    createConcept(
      makeConcept({ id: 'c-c', title: 'C', domain: 'gamma', bloomCeiling: 2 }),
    );

    // Alpha gets many activities (will fill most of the slots)
    for (let i = 1; i <= 15; i++) {
      createActivity(
        makeActivity({
          id: `a-${i}`,
          conceptId: 'c-a',
          bloomLevel: 3,
          activityType: 'elaboration',
        }),
      );
    }
    // Beta and gamma each have a few activities
    for (let i = 1; i <= 3; i++) {
      createActivity(
        makeActivity({
          id: `b-${i}`,
          conceptId: 'c-b',
          bloomLevel: 3,
          activityType: 'elaboration',
        }),
      );
    }
    for (let i = 1; i <= 3; i++) {
      createActivity(
        makeActivity({
          id: `c-${i}`,
          conceptId: 'c-c',
          bloomLevel: 3,
          activityType: 'elaboration',
        }),
      );
    }

    const result = await buildDailySession({ targetActivities: 10 });
    const coveredDomains = new Set(result.domainsCovered);

    // All 3 domains should appear
    expect(coveredDomains.has('alpha')).toBe(true);
    expect(coveredDomains.has('beta')).toBe(true);
    expect(coveredDomains.has('gamma')).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 12. domainsCovered reflects all placed activities
  // ──────────────────────────────────────────────────────────────────────────
  it('reports domainsCovered as unique domains across all placed activities', async () => {
    createConcept(
      makeConcept({
        id: 'c-x',
        title: 'X',
        domain: 'xdomain',
        bloomCeiling: 2,
      }),
    );
    createConcept(
      makeConcept({
        id: 'c-y',
        title: 'Y',
        domain: 'ydomain',
        bloomCeiling: 2,
      }),
    );

    for (let i = 1; i <= 3; i++) {
      createActivity(
        makeActivity({ id: `x-${i}`, conceptId: 'c-x', bloomLevel: 3 }),
      );
    }
    for (let i = 1; i <= 3; i++) {
      createActivity(
        makeActivity({ id: `y-${i}`, conceptId: 'c-y', bloomLevel: 3 }),
      );
    }

    const result = await buildDailySession({ targetActivities: 20 });
    expect(result.domainsCovered).toContain('xdomain');
    expect(result.domainsCovered).toContain('ydomain');
    // No duplicates
    expect(result.domainsCovered.length).toBe(
      new Set(result.domainsCovered).size,
    );
  });
});
