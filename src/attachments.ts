import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

/**
 * Regex matching attachment markers embedded in message content.
 * Format: (__attachment__:/absolute/path/to/file)
 */
export const ATTACHMENT_MARKER_RE = /\(__attachment__:([^)]+)\)/;

/** Format bytes into human-readable size string. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Deduplicate a filename within a directory.
 * If "report.pdf" exists, returns "report-2.pdf", then "report-3.pdf", etc.
 */
function deduplicateFilename(dir: string, filename: string): string {
  if (!fs.existsSync(path.join(dir, filename))) return filename;

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let counter = 2;
  while (fs.existsSync(path.join(dir, `${base}-${counter}${ext}`))) {
    counter++;
  }
  return `${base}-${counter}${ext}`;
}

/**
 * Scan messages for attachment markers, copy files to the group's inputs/
 * directory, and rewrite message content with container-visible paths.
 *
 * Mutates message.content in-place. DB records are untouched.
 *
 * @returns List of consumed source file paths (for cleanup later)
 */
export function prepareAttachments(
  messages: { content: string }[],
  groupFolder: string,
  groupsDir: string,
): string[] {
  const consumed: string[] = [];
  const inputsDir = path.join(groupsDir, groupFolder, 'inputs');

  for (const msg of messages) {
    // Note: matches only the first marker per message. Telegram sends one
    // attachment per message event, so this is sufficient. If a future channel
    // embeds multiple markers, switch to matchAll with the global flag.
    const match = msg.content.match(ATTACHMENT_MARKER_RE);
    if (!match) continue;

    const sourcePath = match[1];
    const marker = match[0]; // full (__attachment__:...) string

    // Strip marker from content first (we'll append the rewritten path if successful)
    const contentWithoutMarker = msg.content.replace(marker, '').trimEnd();

    if (!fs.existsSync(sourcePath)) {
      logger.warn(
        { sourcePath },
        'Attachment source file missing, stripping marker',
      );
      msg.content = contentWithoutMarker;
      continue;
    }

    // Ensure inputs dir exists
    fs.mkdirSync(inputsDir, { recursive: true });

    // Determine target filename.
    // If the link text contains "Label: filename.ext" (e.g. "Document: report.pdf"),
    // extract the filename from the label. Otherwise fall back to the source basename.
    const sourceBasename = path.basename(sourcePath);
    const labelMatch = contentWithoutMarker.match(
      /\[(?:[^:\]]+):\s*([^\]]+)\]/,
    );
    const originalName = labelMatch ? labelMatch[1].trim() : sourceBasename;
    const targetName = deduplicateFilename(inputsDir, originalName);
    const targetPath = path.join(inputsDir, targetName);

    try {
      fs.copyFileSync(sourcePath, targetPath);
    } catch (err) {
      logger.warn({ sourcePath, targetPath, err }, 'Failed to copy attachment');
      msg.content = contentWithoutMarker;
      continue;
    }

    const fileSize = fs.statSync(targetPath).size;
    const containerPath = `/workspace/group/inputs/${targetName}`;

    // Rewrite content: insert " — available at ... (size)" before the closing bracket
    // Handles both "[Document: name]" and "[Photo]" patterns
    if (contentWithoutMarker.includes(']')) {
      const bracketIdx = contentWithoutMarker.indexOf(']');
      const before = contentWithoutMarker.slice(0, bracketIdx);
      const after = contentWithoutMarker.slice(bracketIdx + 1);
      msg.content = `${before} — available at ${containerPath} (${formatFileSize(fileSize)})]${after}`;
    } else {
      // Fallback: append path info
      msg.content = `${contentWithoutMarker} — available at ${containerPath} (${formatFileSize(fileSize)})`;
    }

    consumed.push(sourcePath);
  }

  return consumed;
}

/**
 * Clean up attachment files after container teardown.
 * Removes the group's inputs/ directory and deletes consumed source files.
 */
export function cleanupAttachments(
  groupFolder: string,
  sourcePaths: string[],
  groupsDir: string,
): void {
  // Remove inputs directory
  const inputsDir = path.join(groupsDir, groupFolder, 'inputs');
  try {
    fs.rmSync(inputsDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ inputsDir, err }, 'Failed to remove inputs directory');
  }

  // Delete consumed source files
  for (const sourcePath of sourcePaths) {
    try {
      fs.unlinkSync(sourcePath);
    } catch {
      // Already deleted or never existed — fine
    }
  }
}
