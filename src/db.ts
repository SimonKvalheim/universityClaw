/**
 * Barrel re-export — all database functions are now implemented in src/db/index.ts
 * using Drizzle ORM. This file preserves the original import paths so every
 * consumer (`import { ... } from './db.js'`) continues to work unchanged.
 */
export {
  // Lifecycle
  initDatabase,
  _initTestDatabase,
  _closeDatabase,
  getDb,

  // Chat & Messages
  type ChatInfo,
  storeChatMetadata,
  updateChatName,
  getAllChats,
  getLastGroupSync,
  setLastGroupSync,
  storeMessage,
  storeMessageDirect,
  getNewMessages,
  getMessagesSince,

  // Tasks
  createTask,
  getTaskById,
  getTasksForGroup,
  getAllTasks,
  updateTask,
  deleteTask,
  getDueTasks,
  updateTaskAfterRun,
  logTaskRun,

  // Router state & Sessions
  getRouterState,
  setRouterState,
  getSession,
  setSession,
  getAllSessions,

  // Registered groups
  getRegisteredGroup,
  setRegisteredGroup,
  getAllRegisteredGroups,

  // Ingestion
  getIngestionJobByPath,
  getCompletedJobByHash,
  getIngestionJobByZoteroKey,
  deleteIngestionJob,
  createIngestionJob,
  getIngestionJobById,
  getIngestionJobs,
  getJobsByStatus,
  updateIngestionJob,
  getRecentlyCompletedJobs,

  // Settings
  getSetting,
  setSetting,

  // RAG index tracker
  type TrackedDoc,
  getTrackedDoc,
  upsertTrackedDoc,
  deleteTrackedDoc,

  // Citation edges
  insertCitationEdge,
  deleteCitationEdges,
  getCites,
  getCitedBy,

  // Zotero sync
  getZoteroSyncVersion,
  setZoteroSyncVersion,
} from './db/index.js';
