import { watch, type FSWatcher } from 'chokidar';
import { readFileSync } from 'fs';
import { relative, resolve } from 'path';
import { logger } from '../logger.js';
import { getTrackedDoc, upsertTrackedDoc, deleteTrackedDoc } from '../db.js';
import type { RagClient } from './rag-client.js';
import { parseFrontmatter } from '../vault/frontmatter.js';
import { extractWikilinks } from '../vault/wikilinks.js';
import { computeDocId } from './doc-id.js';

/**
 * Paths relative to vaultDir that should be indexed into LightRAG.
 * Only sources/, concepts/, and profile/archive/ are indexed.
 * profile/ top-level docs (student profile, knowledge map, study log) are
 * working documents read in full by the agent — not suitable for RAG retrieval.
 * Explicitly excluded: drafts/ (working area for ingestion pipeline),
 * attachments/ (binary figures), and any other top-level directories.
 */
const ALLOWED_PATHS = ['concepts', 'sources', 'profile/archive'];

/** Convert a slug like "working-memory-architecture" to "Working Memory Architecture". */
function slugToTitle(slug: string): string {
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export class RagIndexer {
  private vaultDir: string;
  private ragClient: RagClient;
  private watcher: FSWatcher | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(vaultDir: string, ragClient: RagClient) {
    this.vaultDir = resolve(vaultDir);
    this.ragClient = ragClient;
  }

  start(): void {
    const watchPaths = ALLOWED_PATHS.map((p) => resolve(this.vaultDir, p));
    this.watcher = watch(watchPaths, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500 },
      ignored: [/(^|[/\\])\./],
    });
    this.watcher.on('add', (fp) => this.enqueue(() => this.indexFile(fp)));
    this.watcher.on('change', (fp) => this.enqueue(() => this.indexFile(fp)));
    this.watcher.on('unlink', (fp) =>
      this.enqueue(() => this.handleUnlink(fp)),
    );
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Serialize operations to avoid overwhelming LightRAG. */
  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn, fn).catch(() => {});
  }

  async indexFile(filePath: string): Promise<void> {
    if (!filePath.endsWith('.md')) return;

    const relPath = relative(this.vaultDir, filePath);

    const isAllowed = ALLOWED_PATHS.some(
      (p) => relPath.startsWith(p + '/') || relPath.startsWith(p + '\\'),
    );
    if (!isAllowed) return;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const { data: fm, content: body } = parseFrontmatter(content);
    if (fm.status === 'draft') return;

    const title = fm.title || relPath;
    const type = fm.type || 'unknown';
    const topics = Array.isArray(fm.topics) ? fm.topics.join(', ') : '';
    const sourceDoc = fm.source_doc || '';
    const verification = fm.verification_status || 'unverified';

    const parts = [`Title: ${title}`, `Type: ${type}`];
    if (topics) parts.push(`Topics: ${topics}`);
    if (sourceDoc) parts.push(`Source: ${sourceDoc}`);
    parts.push(`Verification: ${verification}`);

    const prefix = `[${parts.join(' | ')}]`;
    const indexed = `${prefix}\nSource path: ${relPath}\n\n${body}`;

    // Compute hash and check tracker.
    // Note: parseFrontmatter calls JS .trim() on body content, which strips
    // Unicode whitespace (U+00A0) that Python's strip() keeps. This is a
    // pre-existing behavior — the hash we compute here is based on what we
    // actually send to LightRAG, so it stays consistent for our tracking
    // purposes even if it diverges from what LightRAG would compute on the
    // raw file content.
    const { hash, docId } = computeDocId(indexed);
    const tracked = getTrackedDoc(relPath);

    if (tracked && tracked.content_hash === hash) {
      return; // Already indexed with identical content
    }

    // Delete old doc if content changed
    if (tracked) {
      try {
        await this.ragClient.deleteDocument(tracked.doc_id);
      } catch (err) {
        logger.warn({ err, relPath }, 'Failed to delete old doc from LightRAG');
      }
    }

    // Index new content
    try {
      await this.ragClient.index(indexed);
    } catch (err) {
      logger.warn({ err, relPath }, 'Failed to index file');
      return; // Don't update tracker — will retry on next event/restart
    }

    upsertTrackedDoc(relPath, docId, hash);

    // Inject wikilinks as explicit graph relationships (non-fatal)
    await this.injectWikilinks(content, fm);
  }

  /**
   * Parse wikilinks from note content and inject each as a graph relationship
   * in LightRAG. Only targets that resolve to allowed indexing paths and already
   * exist as entities in the graph are injected. Failures are logged but never
   * block indexing.
   */
  async injectWikilinks(
    content: string,
    frontmatter: Record<string, unknown>,
  ): Promise<void> {
    const links = extractWikilinks(content);
    if (links.length === 0) return;

    const sourceTitle = String(frontmatter.title || '');
    if (!sourceTitle) return;

    for (const link of links) {
      const targetTitle = slugToTitle(link.target);

      try {
        // Only create relation if both entities exist in the graph
        const [sourceExists, targetExists] = await Promise.all([
          this.ragClient.entityExists(sourceTitle),
          this.ragClient.entityExists(targetTitle),
        ]);
        if (!sourceExists || !targetExists) continue;

        await this.ragClient.createRelation(sourceTitle, targetTitle, {
          description: `Explicitly linked in vault: [[${sourceTitle}]] references [[${targetTitle}]]`,
          keywords: 'references, wikilink',
          weight: 1.0,
        });
      } catch (err) {
        logger.warn(
          { err, source: sourceTitle, target: targetTitle },
          'Failed to inject wikilink relation',
        );
      }
    }
  }

  async handleUnlink(filePath: string): Promise<void> {
    if (!filePath.endsWith('.md')) return;

    const relPath = relative(this.vaultDir, filePath);
    const tracked = getTrackedDoc(relPath);
    if (!tracked) return;

    try {
      await this.ragClient.deleteDocument(tracked.doc_id);
    } catch (err) {
      logger.warn(
        { err, relPath },
        'Failed to delete doc from LightRAG on unlink',
      );
    }

    deleteTrackedDoc(relPath);
  }
}
