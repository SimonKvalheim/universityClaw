import { ZoteroLocalClient } from './zotero-client.js';
import { ZoteroMetadata } from './types.js';
import {
  getZoteroSyncVersion,
  setZoteroSyncVersion,
  getIngestionJobByZoteroKey,
} from '../db.js';
import { logger } from '../logger.js';

export interface ZoteroWatcherOpts {
  client: ZoteroLocalClient;
  excludeCollection: string;
  onItem: (
    filePath: string,
    zoteroKey: string,
    metadata: ZoteroMetadata,
  ) => void;
  pollIntervalMs?: number;
  /** Sync-version key in the `zotero_sync` table. Default `library_version`
   *  (personal library). Use `group:{id}:library_version` for group libraries. */
  syncKey?: string;
  /** Label used in log messages to identify the library (e.g. "user", "group:6515112"). */
  label?: string;
}

export class ZoteroWatcher {
  private client: ZoteroLocalClient;
  private excludeCollection: string;
  private excludeCollectionKey: string | null = null;
  private onItem: ZoteroWatcherOpts['onItem'];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private syncKey: string;
  private label: string;

  constructor(opts: ZoteroWatcherOpts) {
    this.client = opts.client;
    this.excludeCollection = opts.excludeCollection;
    this.onItem = opts.onItem;
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
    this.syncKey = opts.syncKey ?? 'library_version';
    this.label = opts.label ?? 'user';
  }

  async start(): Promise<void> {
    if (this.excludeCollection) {
      await this.resolveExcludeCollection();
    }

    await this.poll();
    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        logger.warn({ err, library: this.label }, 'Zotero poll error');
      });
    }, this.pollIntervalMs);

    logger.info({ library: this.label }, 'Zotero watcher started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async resolveExcludeCollection(): Promise<void> {
    try {
      const collections = (await this.client.getCollections()) as {
        key: string;
        data: { name: string };
      }[];
      const match = collections.find(
        (c) => c.data.name === this.excludeCollection,
      );
      if (match) {
        this.excludeCollectionKey = match.key;
        logger.info(
          { collection: this.excludeCollection, key: match.key },
          'Resolved Zotero exclude collection',
        );
      } else {
        logger.warn(
          { collection: this.excludeCollection },
          'Zotero exclude collection not found — all items will be processed',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to resolve exclude collection');
    }
  }

  async poll(): Promise<void> {
    const storedVersion = getZoteroSyncVersion(this.syncKey);

    let result: { items: unknown[]; version: number };
    try {
      result = await this.client.getItems(storedVersion ?? undefined);
    } catch (err) {
      logger.warn(
        { err, library: this.label },
        'Zotero not reachable — will retry next cycle',
      );
      return;
    }

    if (storedVersion === null) {
      setZoteroSyncVersion(this.syncKey, result.version);
      logger.info(
        {
          library: this.label,
          version: result.version,
          itemCount: result.items.length,
        },
        'Zotero first connect — stored version, skipping existing items',
      );
      return;
    }

    if (result.items.length === 0) {
      setZoteroSyncVersion(this.syncKey, result.version);
      return;
    }

    const items = result.items as {
      key: string;
      data: {
        title: string;
        itemType: string;
        collections: string[];
        creators: {
          firstName: string;
          lastName: string;
          creatorType: string;
        }[];
        date: string;
        DOI?: string;
        url?: string;
        publicationTitle?: string;
        tags: { tag: string }[];
        abstractNote?: string;
      };
      meta: { numChildren?: number };
    }[];

    for (const item of items) {
      try {
        await this.processItem(item);
      } catch (err) {
        logger.warn(
          { library: this.label, key: item.key, title: item.data.title, err },
          'Failed to process Zotero item',
        );
      }
    }

    setZoteroSyncVersion(this.syncKey, result.version);
  }

  private async processItem(item: {
    key: string;
    data: {
      title: string;
      itemType: string;
      collections: string[];
      creators: { firstName: string; lastName: string; creatorType: string }[];
      date: string;
      DOI?: string;
      url?: string;
      publicationTitle?: string;
      tags: { tag: string }[];
      abstractNote?: string;
    };
    meta: { numChildren?: number };
  }): Promise<void> {
    if (item.data.itemType === 'attachment' || item.data.itemType === 'note')
      return;

    if (
      this.excludeCollectionKey &&
      item.data.collections.includes(this.excludeCollectionKey)
    ) {
      logger.debug({ key: item.key }, 'Skipping item in excluded collection');
      return;
    }

    const existing = getIngestionJobByZoteroKey(item.key);
    if (existing) {
      logger.debug(
        { key: item.key, existingJob: existing.id },
        'Skipping already-processed Zotero item',
      );
      return;
    }

    const filePath = await this.resolvePdf(item.key);
    if (!filePath) {
      logger.debug({ key: item.key }, 'No PDF attachment — skipping');
      return;
    }

    const metadata: ZoteroMetadata = {
      title: item.data.title,
      creators: item.data.creators,
      date: item.data.date,
      DOI: item.data.DOI,
      url: item.data.url,
      publicationTitle: item.data.publicationTitle,
      tags: item.data.tags.map((t) => t.tag),
      abstractNote: item.data.abstractNote,
      itemType: item.data.itemType,
    };

    logger.info(
      { key: item.key, title: item.data.title, filePath },
      'Zotero: enqueuing item for ingestion',
    );

    this.onItem(filePath, item.key, metadata);
  }

  private async resolvePdf(itemKey: string): Promise<string | null> {
    const children = (await this.client.getChildren(itemKey)) as {
      key: string;
      data: { itemType: string; contentType: string; filename?: string };
      links?: { enclosure?: { length?: number } };
    }[];

    const pdfAttachments = children.filter(
      (c) =>
        c.data.itemType === 'attachment' &&
        c.data.contentType === 'application/pdf',
    );

    if (pdfAttachments.length === 0) return null;

    const sorted = pdfAttachments.sort(
      (a, b) =>
        (b.links?.enclosure?.length ?? 0) - (a.links?.enclosure?.length ?? 0),
    );

    return this.client.getFileUrl(sorted[0].key);
  }
}
