import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  eq,
  and,
  gt,
  lte,
  ne,
  like,
  not,
  isNotNull,
  inArray,
  desc,
  sql,
} from 'drizzle-orm';

import { DATA_DIR, STORE_DIR } from '../config.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import type {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from '../types.js';
import * as schema from './schema/index.js';
import { runMigrations } from './migrate.js';

// Module-level state
let db: BetterSQLite3Database<typeof schema>;
let rawSqlite: Database.Database;

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  rawSqlite = new Database(dbPath);
  rawSqlite.pragma('journal_mode = WAL');
  rawSqlite.pragma('foreign_keys = ON');

  db = drizzle(rawSqlite, { schema });

  runMigrations(db);
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  rawSqlite = new Database(':memory:');
  rawSqlite.pragma('foreign_keys = ON');

  db = drizzle(rawSqlite, { schema });

  runMigrations(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  if (rawSqlite) rawSqlite.close();
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  return db;
}

// ====================================================================
// Chat & Messages
// ====================================================================

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    db.insert(schema.chats)
      .values({
        jid: chatJid,
        name,
        last_message_time: timestamp,
        channel: ch,
        is_group: group,
      })
      .onConflictDoUpdate({
        target: schema.chats.jid,
        set: {
          name: sql`excluded.name`,
          last_message_time: sql`MAX(${schema.chats.last_message_time}, excluded.last_message_time)`,
          channel: sql`COALESCE(excluded.channel, ${schema.chats.channel})`,
          is_group: sql`COALESCE(excluded.is_group, ${schema.chats.is_group})`,
        },
      })
      .run();
  } else {
    db.insert(schema.chats)
      .values({
        jid: chatJid,
        name: chatJid,
        last_message_time: timestamp,
        channel: ch,
        is_group: group,
      })
      .onConflictDoUpdate({
        target: schema.chats.jid,
        set: {
          last_message_time: sql`MAX(${schema.chats.last_message_time}, excluded.last_message_time)`,
          channel: sql`COALESCE(excluded.channel, ${schema.chats.channel})`,
          is_group: sql`COALESCE(excluded.is_group, ${schema.chats.is_group})`,
        },
      })
      .run();
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.insert(schema.chats)
    .values({
      jid: chatJid,
      name,
      last_message_time: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.chats.jid,
      set: { name: sql`excluded.name` },
    })
    .run();
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .select({
      jid: schema.chats.jid,
      name: schema.chats.name,
      last_message_time: schema.chats.last_message_time,
      channel: schema.chats.channel,
      is_group: schema.chats.is_group,
    })
    .from(schema.chats)
    .orderBy(desc(schema.chats.last_message_time))
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  const row = db
    .select({ last_message_time: schema.chats.last_message_time })
    .from(schema.chats)
    .where(eq(schema.chats.jid, '__group_sync__'))
    .get();
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.insert(schema.chats)
    .values({
      jid: '__group_sync__',
      name: '__group_sync__',
      last_message_time: now,
    })
    .onConflictDoUpdate({
      target: schema.chats.jid,
      set: { last_message_time: now },
    })
    .run();
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.insert(schema.messages)
    .values({
      id: msg.id,
      chat_jid: msg.chat_jid,
      sender: msg.sender,
      sender_name: msg.sender_name,
      content: msg.content,
      timestamp: msg.timestamp,
      is_from_me: msg.is_from_me ? 1 : 0,
      is_bot_message: msg.is_bot_message ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: [schema.messages.id, schema.messages.chat_jid],
      set: {
        sender: sql`excluded.sender`,
        sender_name: sql`excluded.sender_name`,
        content: sql`excluded.content`,
        timestamp: sql`excluded.timestamp`,
        is_from_me: sql`excluded.is_from_me`,
        is_bot_message: sql`excluded.is_bot_message`,
      },
    })
    .run();
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.insert(schema.messages)
    .values({
      id: msg.id,
      chat_jid: msg.chat_jid,
      sender: msg.sender,
      sender_name: msg.sender_name,
      content: msg.content,
      timestamp: msg.timestamp,
      is_from_me: msg.is_from_me ? 1 : 0,
      is_bot_message: msg.is_bot_message ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: [schema.messages.id, schema.messages.chat_jid],
      set: {
        sender: sql`excluded.sender`,
        sender_name: sql`excluded.sender_name`,
        content: sql`excluded.content`,
        timestamp: sql`excluded.timestamp`,
        is_from_me: sql`excluded.is_from_me`,
        is_bot_message: sql`excluded.is_bot_message`,
      },
    })
    .run();
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const rows = db
    .select({
      id: schema.messages.id,
      chat_jid: schema.messages.chat_jid,
      sender: schema.messages.sender,
      sender_name: schema.messages.sender_name,
      content: schema.messages.content,
      timestamp: schema.messages.timestamp,
      is_from_me: schema.messages.is_from_me,
    })
    .from(schema.messages)
    .where(
      and(
        gt(schema.messages.timestamp, lastTimestamp),
        inArray(schema.messages.chat_jid, jids),
        eq(schema.messages.is_bot_message, 0),
        not(like(schema.messages.content, `${botPrefix}:%`)),
        ne(schema.messages.content, ''),
        isNotNull(schema.messages.content),
      ),
    )
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit)
    .all()
    .reverse() as unknown as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  return db
    .select({
      id: schema.messages.id,
      chat_jid: schema.messages.chat_jid,
      sender: schema.messages.sender,
      sender_name: schema.messages.sender_name,
      content: schema.messages.content,
      timestamp: schema.messages.timestamp,
      is_from_me: schema.messages.is_from_me,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.chat_jid, chatJid),
        gt(schema.messages.timestamp, sinceTimestamp),
        eq(schema.messages.is_bot_message, 0),
        not(like(schema.messages.content, `${botPrefix}:%`)),
        ne(schema.messages.content, ''),
        isNotNull(schema.messages.content),
      ),
    )
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit)
    .all()
    .reverse() as unknown as NewMessage[];
}

// ====================================================================
// Tasks
// ====================================================================

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.insert(schema.scheduled_tasks)
    .values({
      id: task.id,
      group_folder: task.group_folder,
      chat_jid: task.chat_jid,
      prompt: task.prompt,
      script: task.script || null,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      context_mode: task.context_mode || 'isolated',
      next_run: task.next_run,
      status: task.status,
      created_at: task.created_at,
    })
    .run();
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db
    .select()
    .from(schema.scheduled_tasks)
    .where(eq(schema.scheduled_tasks.id, id))
    .get() as ScheduledTask | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .select()
    .from(schema.scheduled_tasks)
    .where(eq(schema.scheduled_tasks.group_folder, groupFolder))
    .orderBy(desc(schema.scheduled_tasks.created_at))
    .all() as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .select()
    .from(schema.scheduled_tasks)
    .orderBy(desc(schema.scheduled_tasks.created_at))
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const set: Record<string, unknown> = {};

  if (updates.prompt !== undefined) set.prompt = updates.prompt;
  if (updates.script !== undefined) set.script = updates.script || null;
  if (updates.schedule_type !== undefined)
    set.schedule_type = updates.schedule_type;
  if (updates.schedule_value !== undefined)
    set.schedule_value = updates.schedule_value;
  if (updates.next_run !== undefined) set.next_run = updates.next_run;
  if (updates.status !== undefined) set.status = updates.status;

  if (Object.keys(set).length === 0) return;

  db.update(schema.scheduled_tasks)
    .set(set)
    .where(eq(schema.scheduled_tasks.id, id))
    .run();
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.delete(schema.task_run_logs)
    .where(eq(schema.task_run_logs.task_id, id))
    .run();
  db.delete(schema.scheduled_tasks)
    .where(eq(schema.scheduled_tasks.id, id))
    .run();
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .select()
    .from(schema.scheduled_tasks)
    .where(
      and(
        eq(schema.scheduled_tasks.status, 'active'),
        isNotNull(schema.scheduled_tasks.next_run),
        lte(schema.scheduled_tasks.next_run, now),
      ),
    )
    .orderBy(schema.scheduled_tasks.next_run)
    .all() as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  const set: Record<string, unknown> = {
    next_run: nextRun,
    last_run: now,
    last_result: lastResult,
  };
  if (nextRun === null) set.status = 'completed';

  db.update(schema.scheduled_tasks)
    .set(set)
    .where(eq(schema.scheduled_tasks.id, id))
    .run();
}

export function logTaskRun(log: TaskRunLog): void {
  db.insert(schema.task_run_logs)
    .values({
      task_id: log.task_id,
      run_at: log.run_at,
      duration_ms: log.duration_ms,
      status: log.status,
      result: log.result,
      error: log.error,
    })
    .run();
}

// ====================================================================
// Router state & Sessions
// ====================================================================

export function getRouterState(key: string): string | undefined {
  const row = db
    .select({ value: schema.router_state.value })
    .from(schema.router_state)
    .where(eq(schema.router_state.key, key))
    .get();
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.insert(schema.router_state)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.router_state.key,
      set: { value },
    })
    .run();
}

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .select({ session_id: schema.sessions.session_id })
    .from(schema.sessions)
    .where(eq(schema.sessions.group_folder, groupFolder))
    .get();
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.insert(schema.sessions)
    .values({ group_folder: groupFolder, session_id: sessionId })
    .onConflictDoUpdate({
      target: schema.sessions.group_folder,
      set: { session_id: sessionId },
    })
    .run();
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .select({
      group_folder: schema.sessions.group_folder,
      session_id: schema.sessions.session_id,
    })
    .from(schema.sessions)
    .all();
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// ====================================================================
// Registered groups
// ====================================================================

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .select()
    .from(schema.registered_groups)
    .where(eq(schema.registered_groups.jid, jid))
    .get();
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.insert(schema.registered_groups)
    .values({
      jid,
      name: group.name,
      folder: group.folder,
      trigger_pattern: group.trigger,
      added_at: group.added_at,
      container_config: group.containerConfig
        ? JSON.stringify(group.containerConfig)
        : null,
      requires_trigger:
        group.requiresTrigger === undefined
          ? 1
          : group.requiresTrigger
            ? 1
            : 0,
      is_main: group.isMain ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: schema.registered_groups.jid,
      set: {
        name: group.name,
        folder: group.folder,
        trigger_pattern: group.trigger,
        added_at: group.added_at,
        container_config: group.containerConfig
          ? JSON.stringify(group.containerConfig)
          : null,
        requires_trigger:
          group.requiresTrigger === undefined
            ? 1
            : group.requiresTrigger
              ? 1
              : 0,
        is_main: group.isMain ? 1 : 0,
      },
    })
    .run();
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.select().from(schema.registered_groups).all();
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// ====================================================================
// Ingestion
// ====================================================================

export function getIngestionJobByPath(
  sourcePath: string,
): { id: string; status: string } | undefined {
  return db
    .select({
      id: schema.ingestion_jobs.id,
      status: schema.ingestion_jobs.status,
    })
    .from(schema.ingestion_jobs)
    .where(eq(schema.ingestion_jobs.source_path, sourcePath))
    .orderBy(desc(schema.ingestion_jobs.created_at))
    .limit(1)
    .get() as { id: string; status: string } | undefined;
}

export function getCompletedJobByHash(
  hash: string,
): { id: string } | undefined {
  return db
    .select({ id: schema.ingestion_jobs.id })
    .from(schema.ingestion_jobs)
    .where(
      and(
        eq(schema.ingestion_jobs.content_hash, hash),
        eq(schema.ingestion_jobs.status, 'completed'),
      ),
    )
    .limit(1)
    .get() as { id: string } | undefined;
}

export function getIngestionJobByZoteroKey(
  zoteroKey: string,
): { id: string; status: string } | undefined {
  return db
    .select({
      id: schema.ingestion_jobs.id,
      status: schema.ingestion_jobs.status,
    })
    .from(schema.ingestion_jobs)
    .where(
      and(
        eq(schema.ingestion_jobs.zotero_key, zoteroKey),
        not(inArray(schema.ingestion_jobs.status, ['dismissed', 'failed'])),
      ),
    )
    .orderBy(desc(schema.ingestion_jobs.created_at))
    .limit(1)
    .get() as { id: string; status: string } | undefined;
}

export function deleteIngestionJob(id: string): void {
  db.delete(schema.ingestion_jobs)
    .where(eq(schema.ingestion_jobs.id, id))
    .run();
}

export function createIngestionJob(
  id: string,
  sourcePath: string,
  sourceFilename: string,
  contentHash?: string,
  zoteroOpts?: {
    source_type?: string;
    zotero_key?: string;
    zotero_metadata?: string;
  },
): void {
  db.insert(schema.ingestion_jobs)
    .values({
      id,
      source_path: sourcePath,
      source_filename: sourceFilename,
      content_hash: contentHash ?? null,
      source_type: zoteroOpts?.source_type ?? 'upload',
      zotero_key: zoteroOpts?.zotero_key ?? null,
      zotero_metadata: zoteroOpts?.zotero_metadata ?? null,
    })
    .run();
}

export function getIngestionJobById(id: string): unknown | undefined {
  return db
    .select()
    .from(schema.ingestion_jobs)
    .where(eq(schema.ingestion_jobs.id, id))
    .get();
}

export function getIngestionJobs(status?: string): unknown[] {
  if (status !== undefined) {
    return db
      .select()
      .from(schema.ingestion_jobs)
      .where(eq(schema.ingestion_jobs.status, status))
      .orderBy(desc(schema.ingestion_jobs.created_at))
      .all();
  }
  return db
    .select()
    .from(schema.ingestion_jobs)
    .orderBy(desc(schema.ingestion_jobs.created_at))
    .all();
}

export function getJobsByStatus(status: string): unknown[] {
  return db
    .select()
    .from(schema.ingestion_jobs)
    .where(eq(schema.ingestion_jobs.status, status))
    .orderBy(desc(schema.ingestion_jobs.created_at))
    .all();
}

export function updateIngestionJob(
  id: string,
  updates: {
    status?: string;
    extraction_path?: string | null;
    error?: string | null;
    content_hash?: string;
    retry_after?: string | null;
    retry_count?: number;
    promoted_paths?: string | null;
  },
): void {
  const set: Record<string, unknown> = {
    updated_at: sql`datetime('now')`,
  };

  if (updates.status !== undefined) {
    set.status = updates.status;
    if (updates.status === 'completed') {
      set.completed_at = sql`datetime('now')`;
    }
  }
  if (updates.extraction_path !== undefined)
    set.extraction_path = updates.extraction_path;
  if (updates.error !== undefined) set.error = updates.error;
  if (updates.content_hash !== undefined)
    set.content_hash = updates.content_hash;
  if (updates.retry_after !== undefined) set.retry_after = updates.retry_after;
  if (updates.retry_count !== undefined) set.retry_count = updates.retry_count;
  if (updates.promoted_paths !== undefined)
    set.promoted_paths = updates.promoted_paths;

  db.update(schema.ingestion_jobs)
    .set(set)
    .where(eq(schema.ingestion_jobs.id, id))
    .run();
}

export function getRecentlyCompletedJobs(limit: number = 10): unknown[] {
  return db
    .select()
    .from(schema.ingestion_jobs)
    .where(eq(schema.ingestion_jobs.status, 'completed'))
    .orderBy(desc(schema.ingestion_jobs.completed_at))
    .limit(limit)
    .all();
}

// ====================================================================
// Settings
// ====================================================================

export function getSetting(key: string, defaultValue: string): string {
  const row = db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();
  return row !== undefined ? row.value : defaultValue;
}

export function setSetting(key: string, value: string): void {
  db.insert(schema.settings)
    .values({
      key,
      value,
      updated_at: sql`datetime('now')`,
    })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: {
        value: sql`excluded.value`,
        updated_at: sql`excluded.updated_at`,
      },
    })
    .run();
}

// ====================================================================
// RAG index tracker
// ====================================================================

export interface TrackedDoc {
  vault_path: string;
  doc_id: string;
  content_hash: string;
  indexed_at: string;
}

export function getTrackedDoc(vaultPath: string): TrackedDoc | null {
  return (
    (db
      .select()
      .from(schema.rag_index_tracker)
      .where(eq(schema.rag_index_tracker.vault_path, vaultPath))
      .get() as TrackedDoc | undefined) ?? null
  );
}

export function upsertTrackedDoc(
  vaultPath: string,
  docId: string,
  contentHash: string,
): void {
  const now = new Date().toISOString();
  db.insert(schema.rag_index_tracker)
    .values({
      vault_path: vaultPath,
      doc_id: docId,
      content_hash: contentHash,
      indexed_at: now,
    })
    .onConflictDoUpdate({
      target: schema.rag_index_tracker.vault_path,
      set: {
        doc_id: sql`excluded.doc_id`,
        content_hash: sql`excluded.content_hash`,
        indexed_at: sql`excluded.indexed_at`,
      },
    })
    .run();
}

export function deleteTrackedDoc(vaultPath: string): void {
  db.delete(schema.rag_index_tracker)
    .where(eq(schema.rag_index_tracker.vault_path, vaultPath))
    .run();
}

// ====================================================================
// Citation edges
// ====================================================================

export function insertCitationEdge(
  sourceSlug: string,
  targetSlug: string,
): void {
  db.insert(schema.citation_edges)
    .values({
      source_slug: sourceSlug,
      target_slug: targetSlug,
      created_at: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
}

export function deleteCitationEdges(sourceSlug: string): void {
  db.delete(schema.citation_edges)
    .where(eq(schema.citation_edges.source_slug, sourceSlug))
    .run();
}

export function getCites(sourceSlug: string): string[] {
  const rows = db
    .select({ target_slug: schema.citation_edges.target_slug })
    .from(schema.citation_edges)
    .where(eq(schema.citation_edges.source_slug, sourceSlug))
    .orderBy(schema.citation_edges.target_slug)
    .all();
  return rows.map((r) => r.target_slug);
}

export function getCitedBy(targetSlug: string): string[] {
  const rows = db
    .select({ source_slug: schema.citation_edges.source_slug })
    .from(schema.citation_edges)
    .where(eq(schema.citation_edges.target_slug, targetSlug))
    .orderBy(schema.citation_edges.source_slug)
    .all();
  return rows.map((r) => r.source_slug);
}

// ====================================================================
// Zotero sync
// ====================================================================

export function getZoteroSyncVersion(): number | null {
  const row = db
    .select({ value: schema.zotero_sync.value })
    .from(schema.zotero_sync)
    .where(eq(schema.zotero_sync.key, 'library_version'))
    .get();
  return row ? parseInt(row.value, 10) : null;
}

export function setZoteroSyncVersion(version: number): void {
  db.insert(schema.zotero_sync)
    .values({ key: 'library_version', value: String(version) })
    .onConflictDoUpdate({
      target: schema.zotero_sync.key,
      set: { value: String(version) },
    })
    .run();
}

// ====================================================================
// JSON migration
// ====================================================================

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
