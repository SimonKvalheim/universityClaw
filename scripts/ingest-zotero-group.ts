/**
 * One-shot enqueue of all PDF attachments in a Zotero GROUP library.
 *
 * The normal Zotero watcher polls only the personal library (/api/users/0).
 * This script mirrors `ZoteroWatcher.processItem` for a single group library
 * so its PDFs are enqueued into the ingestion pipeline with full metadata
 * (title, creators, DOI, tags, abstract) from their parent items.
 *
 * Usage:
 *   npx tsx scripts/ingest-zotero-group.ts <groupId>
 *   npx tsx scripts/ingest-zotero-group.ts 6515112   # TDMA4007
 *
 * Safe to run while NanoClaw is live: SQLite is in WAL mode, the drainer
 * will pick up the new pending jobs on its next 5s tick.
 */
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  initDatabase,
  createIngestionJob,
  getCompletedJobByHash,
  getIngestionJobByZoteroKey,
} from '../src/db.js';
import { ZOTERO_LOCAL_URL } from '../src/config.js';
import type { ZoteroMetadata } from '../src/ingestion/types.js';

const REQUEST_TIMEOUT = 10_000;

interface ZGroupItem {
  key: string;
  data: {
    itemType: string;
    title?: string;
    contentType?: string;
    filename?: string;
    parentItem?: string;
    creators?: { firstName: string; lastName: string; creatorType: string }[];
    date?: string;
    DOI?: string;
    url?: string;
    publicationTitle?: string;
    tags?: { tag: string }[];
    abstractNote?: string;
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

async function getGroupItems(groupId: string): Promise<ZGroupItem[]> {
  return fetchJson<ZGroupItem[]>(
    `${ZOTERO_LOCAL_URL}/api/groups/${groupId}/items?format=json&limit=500`,
  );
}

async function getGroupItem(
  groupId: string,
  key: string,
): Promise<ZGroupItem> {
  return fetchJson<ZGroupItem>(
    `${ZOTERO_LOCAL_URL}/api/groups/${groupId}/items/${key}?format=json`,
  );
}

async function getFilePath(
  groupId: string,
  attachmentKey: string,
): Promise<string | null> {
  const res = await fetch(
    `${ZOTERO_LOCAL_URL}/api/groups/${groupId}/items/${attachmentKey}/file/view/url`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`file URL fetch error: ${res.status}`);
  const url = (await res.text()).trim();
  if (url.startsWith('file://')) {
    return decodeURIComponent(new URL(url).pathname);
  }
  return url || null;
}

function buildMetadata(parent: ZGroupItem['data']): ZoteroMetadata {
  return {
    title: parent.title ?? '',
    creators: parent.creators ?? [],
    date: parent.date ?? '',
    DOI: parent.DOI,
    url: parent.url,
    publicationTitle: parent.publicationTitle,
    tags: (parent.tags ?? []).map((t) => t.tag),
    abstractNote: parent.abstractNote,
    itemType: parent.itemType,
  };
}

async function main(): Promise<void> {
  const groupId = process.argv[2];
  if (!groupId) {
    console.error('Usage: npx tsx scripts/ingest-zotero-group.ts <groupId>');
    process.exit(1);
  }

  initDatabase();

  const items = await getGroupItems(groupId);
  const pdfs = items.filter(
    (i) =>
      i.data.itemType === 'attachment' &&
      i.data.contentType === 'application/pdf',
  );

  console.log(
    `Group ${groupId}: ${items.length} items, ${pdfs.length} PDF attachments`,
  );

  let enqueued = 0;
  let skipped = 0;
  let failed = 0;

  for (const pdf of pdfs) {
    const existing = getIngestionJobByZoteroKey(pdf.key);
    if (existing) {
      console.log(`  skip ${pdf.key} (existing job ${existing.id} [${existing.status}])`);
      skipped++;
      continue;
    }

    let filePath: string | null;
    try {
      filePath = await getFilePath(groupId, pdf.key);
    } catch (err) {
      console.warn(`  fail ${pdf.key} (file URL):`, err);
      failed++;
      continue;
    }
    if (!filePath) {
      console.warn(`  skip ${pdf.key} (no local file)`);
      skipped++;
      continue;
    }

    let metadata: ZoteroMetadata;
    try {
      if (pdf.data.parentItem) {
        const parent = await getGroupItem(groupId, pdf.data.parentItem);
        metadata = buildMetadata(parent.data);
      } else {
        metadata = buildMetadata({
          ...pdf.data,
          title: pdf.data.title ?? pdf.data.filename ?? pdf.key,
          itemType: 'attachment',
        });
      }
    } catch (err) {
      console.warn(`  fail ${pdf.key} (parent fetch):`, err);
      failed++;
      continue;
    }

    let contentHash: string;
    try {
      contentHash = createHash('sha256')
        .update(readFileSync(filePath))
        .digest('hex');
    } catch (err) {
      console.warn(`  fail ${pdf.key} (read file):`, err);
      failed++;
      continue;
    }

    const dup = getCompletedJobByHash(contentHash);
    if (dup) {
      console.log(`  skip ${pdf.key} (content-hash matches completed job ${dup.id})`);
      skipped++;
      continue;
    }

    const jobId = randomUUID();
    createIngestionJob(jobId, filePath, basename(filePath), contentHash, {
      source_type: 'zotero',
      zotero_key: pdf.key,
      zotero_metadata: JSON.stringify(metadata),
    });

    console.log(`  enq  ${pdf.key} → ${jobId}  "${metadata.title.slice(0, 70)}"`);
    enqueued++;
  }

  console.log(
    `\nDone: ${enqueued} enqueued, ${skipped} skipped, ${failed} failed`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
