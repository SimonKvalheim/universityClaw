import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { logger } from '../logger.js';

/**
 * Rotates study-log.md: entries older than 30 days move to archive.
 */
export function rotateStudyLog(profileDir: string, now = new Date()): void {
  const logPath = join(profileDir, 'study-log.md');
  if (!existsSync(logPath)) return;

  const content = readFileSync(logPath, 'utf-8');
  const parsed = matter(content);
  const body = parsed.content;

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 30);

  // Split body into date sections
  const sections = body
    .split(/(?=^## \d{4}-\d{2}-\d{2})/m)
    .filter((s) => s.trim());

  const recent: string[] = [];
  const old: Map<string, string[]> = new Map(); // yearMonth → sections

  for (const section of sections) {
    const dateMatch = section.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) {
      recent.push(section);
      continue;
    }

    const sectionDate = new Date(dateMatch[1]);
    if (sectionDate >= cutoff) {
      recent.push(section);
    } else {
      const yearMonth = dateMatch[1].slice(0, 7); // YYYY-MM
      const existing = old.get(yearMonth) ?? [];
      existing.push(section);
      old.set(yearMonth, existing);
    }
  }

  // Write archived entries
  const archiveDir = join(profileDir, 'archive');
  for (const [yearMonth, archivedSections] of old) {
    const archivePath = join(archiveDir, `study-log-${yearMonth}.md`);
    const archiveContent = archivedSections.join('\n');

    if (existsSync(archivePath)) {
      appendFileSync(archivePath, '\n' + archiveContent);
    } else {
      writeFileSync(
        archivePath,
        `---\ntitle: Study Log ${yearMonth}\ntype: profile\n---\n\n${archiveContent}`,
      );
    }

    logger.info(
      { yearMonth, entries: archivedSections.length },
      'Archived study log entries',
    );
  }

  // Rewrite main log with only recent entries
  if (old.size > 0) {
    const updated = matter.stringify('\n' + recent.join('\n'), parsed.data);
    writeFileSync(logPath, updated);
  }

  // Hard cap: if file exceeds 200 content lines, force-archive oldest
  const finalContent = readFileSync(logPath, 'utf-8');
  const finalParsed = matter(finalContent);
  const contentLines = finalParsed.content.split('\n');
  if (contentLines.length > 200) {
    const kept = contentLines.slice(0, 200);
    const overflow = contentLines.slice(200);
    const overflowText = overflow.join('\n');
    if (overflowText.trim()) {
      const overflowPath = join(
        archiveDir,
        `study-log-overflow-${now.toISOString().slice(0, 10)}.md`,
      );
      writeFileSync(
        overflowPath,
        `---\ntitle: Study Log Overflow\ntype: profile\n---\n\n${overflowText}`,
      );
    }
    const capped = matter.stringify('\n' + kept.join('\n'), finalParsed.data);
    writeFileSync(logPath, capped);
    logger.info('Study log exceeded 200 lines, overflow archived');
  }
}
