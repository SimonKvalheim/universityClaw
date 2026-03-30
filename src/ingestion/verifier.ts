import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../vault/frontmatter.js';
import matter from 'gray-matter';

export interface UnverifiedNote {
  relPath: string;
  absPath: string;
  sourceFile: string | null;
}

export interface VerificationResult {
  relPath: string;
  status: 'agent-verified' | 'unverified';
  issues: string[];
}

/**
 * Collects notes with verification_status: unverified from a list of source paths.
 */
export function collectUnverifiedNotes(
  vaultDir: string,
  sourcePaths: string[],
  maxBatch = 10,
): UnverifiedNote[] {
  const unverified: UnverifiedNote[] = [];

  for (const relPath of sourcePaths) {
    if (unverified.length >= maxBatch) break;

    const absPath = join(vaultDir, relPath);
    try {
      const content = readFileSync(absPath, 'utf-8');
      const { data: fm } = parseFrontmatter(content);
      if (fm.verification_status === 'unverified') {
        unverified.push({
          relPath,
          absPath,
          sourceFile: (fm.source_file as string) || null,
        });
      }
    } catch {
      // File not found or unreadable — skip
    }
  }

  return unverified;
}

/**
 * Updates a note's verification_status and optionally adds issues.
 */
export function updateVerificationStatus(
  notePath: string,
  status: 'agent-verified' | 'human-verified' | 'unverified',
  issues?: string[],
): void {
  const content = readFileSync(notePath, 'utf-8');
  const parsed = matter(content);

  parsed.data.verification_status = status;

  if (status === 'agent-verified' || status === 'human-verified') {
    parsed.data.verified_at = new Date().toISOString().split('T')[0];
  }

  if (issues && issues.length > 0) {
    parsed.data.verification_issues = issues;
  }

  const updated = matter.stringify(parsed.content, parsed.data);
  writeFileSync(notePath, updated);
}
