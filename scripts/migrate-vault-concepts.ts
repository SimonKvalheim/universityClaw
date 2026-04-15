#!/usr/bin/env tsx
/**
 * S2.8 — One-time vault concept migration script
 *
 * Scans existing vault concept notes and backfills them into the concepts table.
 * Idempotent: running twice inserts 0 the second time.
 *
 * Usage: npx tsx scripts/migrate-vault-concepts.ts
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { parseFrontmatter } from '../src/vault/frontmatter.js';
import { initDatabase } from '../src/db/index.js';

// Initialize the database (runs migrations)
initDatabase();

// Dynamic import AFTER db is initialized
const { createConcept, getConceptByVaultPath } = await import(
  '../src/study/queries.js'
);

// ====================================================================
// Domain inference heuristic
// ====================================================================

interface InferenceRule {
  keywords: string[];
  domain: string;
  subdomain: string;
}

const INFERENCE_RULES: InferenceRule[] = [
  {
    keywords: [
      'knowledge-management',
      'km-',
      'tacit-knowledge',
      'explicit-knowledge',
      'seci',
      'nonaka',
      'knowledge-creation',
      'knowledge-sharing',
    ],
    domain: 'Knowledge Management',
    subdomain: 'KM Theory',
  },
  {
    keywords: [
      'organizational-learning',
      'learning-organization',
      'absorptive-capacity',
    ],
    domain: 'Knowledge Management',
    subdomain: 'Organizational Learning',
  },
  {
    keywords: [
      'cognitive-load',
      'working-memory',
      'instructional-design',
      'sweller',
    ],
    domain: 'Cognitive Psychology',
    subdomain: 'Cognitive Load Theory',
  },
  {
    keywords: [
      'spaced-repetition',
      'retrieval-practice',
      'metacognition',
      'self-regulated-learning',
    ],
    domain: 'Cognitive Psychology',
    subdomain: 'Learning & Memory',
  },
  {
    keywords: [
      'digital-transformation',
      'digitalization',
      'digital-strategy',
    ],
    domain: 'Digital Transformation',
    subdomain: 'DT Strategy',
  },
  {
    keywords: [
      'business-process',
      'bpm',
      'workflow',
      'process-improvement',
    ],
    domain: 'Digital Transformation',
    subdomain: 'Business Process Management',
  },
  {
    keywords: [
      'research-methodology',
      'scientific-methods',
      'qualitative-research',
      'quantitative-research',
      'action-research',
      'case-study-research',
    ],
    domain: 'Research Methods',
    subdomain: 'Research Design',
  },
  {
    keywords: [
      'philosophy-of-science',
      'epistemology',
      'ontology',
      'paradigm',
    ],
    domain: 'Research Methods',
    subdomain: 'Philosophy of Science',
  },
  {
    keywords: [
      'information-systems',
      'sociotechnical',
      'technology-acceptance',
    ],
    domain: 'Information Systems',
    subdomain: 'IS Theory',
  },
  {
    keywords: [
      'artificial-intelligence',
      'ai-',
      'machine-learning',
      'deep-learning',
      'neural-network',
      'llm',
      'transformer',
    ],
    domain: 'Artificial Intelligence',
    subdomain: 'AI Foundations',
  },
];

/**
 * Infer domain and subdomain from a topics array using keyword matching.
 * Returns null if no rule matches.
 */
function inferDomain(
  topics: string[],
): { domain: string; subdomain: string } | null {
  const haystack = topics.join(' ').toLowerCase();
  for (const rule of INFERENCE_RULES) {
    if (rule.keywords.some((kw) => haystack.includes(kw))) {
      return { domain: rule.domain, subdomain: rule.subdomain };
    }
  }
  return null;
}

// ====================================================================
// Main migration
// ====================================================================

const VAULT_DIR = process.env.VAULT_DIR ?? './vault';
const conceptsDir = join(VAULT_DIR, 'concepts');

let files: string[];
try {
  files = readdirSync(conceptsDir).filter((f) => f.endsWith('.md'));
} catch (err) {
  console.error(`Failed to read concepts directory: ${conceptsDir}`);
  console.error(err);
  process.exit(1);
}

console.log(`Found ${files.length} concept files in ${conceptsDir}`);

let inserted = 0;
let skippedExists = 0;
let skippedNoTitle = 0;
let unclassified = 0;

for (const filename of files) {
  const relPath = `concepts/${filename}`;

  // Idempotency: skip if already in DB
  const existing = getConceptByVaultPath(relPath);
  if (existing) {
    skippedExists++;
    continue;
  }

  const fullPath = join(conceptsDir, filename);
  const raw = readFileSync(fullPath, 'utf-8');
  const { data } = parseFrontmatter(raw);

  // Skip notes without a title
  const title = typeof data.title === 'string' ? data.title.trim() : null;
  if (!title) {
    skippedNoTitle++;
    console.warn(`  [skip] No title: ${relPath}`);
    continue;
  }

  // Resolve domain
  let domain: string | null = null;
  let subdomain: string | null = null;

  if (typeof data.domain === 'string' && data.domain.trim()) {
    domain = data.domain.trim();
    subdomain =
      typeof data.subdomain === 'string' ? data.subdomain.trim() : null;
  } else {
    // Infer from topics
    const topics = Array.isArray(data.topics)
      ? (data.topics as unknown[])
          .filter((t): t is string => typeof t === 'string')
      : [];
    const inferred = inferDomain(topics);
    if (inferred) {
      domain = inferred.domain;
      subdomain = inferred.subdomain;
    }
    // If no inference match, domain stays null — concept is still inserted
  }

  const course =
    typeof data.course === 'string' && data.course.trim()
      ? data.course.trim()
      : null;

  createConcept({
    id: randomUUID(),
    title,
    domain,
    subdomain,
    course,
    vaultNotePath: relPath,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  if (!domain) unclassified++;
  console.log(`  [insert] ${title} → ${domain ?? '(unclassified)'} / ${subdomain ?? ''}`);
  inserted++;
}

console.log('');
console.log('=== Migration complete ===');
console.log(`  Inserted:            ${inserted}`);
console.log(`  Skipped (exists):    ${skippedExists}`);
console.log(`  Skipped (no title):  ${skippedNoTitle}`);
console.log(`  Unclassified:        ${unclassified}`);
console.log(`  Total files:         ${files.length}`);
