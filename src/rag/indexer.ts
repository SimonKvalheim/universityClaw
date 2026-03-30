import { watch, type FSWatcher } from 'chokidar';
import { readFileSync } from 'fs';
import { relative, resolve } from 'path';
import { logger } from '../logger.js';
import type { RagClient } from './rag-client.js';
import { parseFrontmatter } from '../vault/frontmatter.js';

/** Paths relative to vaultDir that should be indexed. */
const ALLOWED_PATHS = ['concepts', 'sources', 'profile/archive'];

export class RagIndexer {
  private vaultDir: string;
  private ragClient: RagClient;
  private watcher: FSWatcher | null = null;

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
    this.watcher.on('add', (fp) => this.indexFile(fp).catch(() => {}));
    this.watcher.on('change', (fp) => this.indexFile(fp).catch(() => {}));
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  async indexFile(filePath: string): Promise<void> {
    if (!filePath.endsWith('.md')) return;

    const relPath = relative(this.vaultDir, filePath);

    // Allowlist check: must be under one of ALLOWED_PATHS
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

    try {
      await this.ragClient.index(indexed);
    } catch (err) {
      logger.warn({ err, relPath }, 'Failed to index file');
    }
  }
}
