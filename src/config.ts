import os from 'os';
import path, { join } from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TELEGRAM_BOT_POOL',
  'TZ',
  'ZOTERO_ENABLED',
  'ZOTERO_API_KEY',
  'ZOTERO_USER_ID',
  'ZOTERO_POLL_INTERVAL',
  'ZOTERO_EXCLUDE_COLLECTION',
  'ZOTERO_LOCAL_URL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = process.env.STORE_DIR
  ? path.resolve(process.env.STORE_DIR)
  : path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), 'vault');
export const UPLOAD_DIR =
  process.env.UPLOAD_DIR || join(process.cwd(), 'upload');
export const DASHBOARD_PORT = parseInt(
  process.env.DASHBOARD_PORT || '3100',
  10,
);
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

export const EXTRACTION_TIMEOUT = parseInt(
  process.env.EXTRACTION_TIMEOUT || '600000',
  10,
); // 10min default
export const PIPELINE_TIMEOUT = parseInt(
  process.env.PIPELINE_TIMEOUT || '1200000',
  10,
); // 20min default — pipeline-level timeout, shorter than container hard timeout
export const MAX_EXTRACTION_CONCURRENT = parseInt(
  process.env.MAX_EXTRACTION_CONCURRENT || '3',
  10,
);
export const EXTRACTIONS_DIR = path.resolve(DATA_DIR, 'extractions');

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  envConfig.TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

export const WEB_CHANNEL_PORT = parseInt(
  process.env.WEB_CHANNEL_PORT || '3200',
  10,
);

export const SENTINEL_TIMEOUT = parseInt(
  process.env.SENTINEL_TIMEOUT || '600000',
  10,
); // 10min default
export const PROCESSED_DIR = path.resolve(UPLOAD_DIR, 'processed');

export const ZOTERO_ENABLED =
  (
    process.env.ZOTERO_ENABLED ||
    envConfig.ZOTERO_ENABLED ||
    ''
  ).toLowerCase() === 'true';
export const ZOTERO_API_KEY =
  process.env.ZOTERO_API_KEY || envConfig.ZOTERO_API_KEY || '';
export const ZOTERO_USER_ID =
  process.env.ZOTERO_USER_ID || envConfig.ZOTERO_USER_ID || '';
export const ZOTERO_POLL_INTERVAL = parseInt(
  process.env.ZOTERO_POLL_INTERVAL || envConfig.ZOTERO_POLL_INTERVAL || '60000',
  10,
);
export const ZOTERO_EXCLUDE_COLLECTION =
  process.env.ZOTERO_EXCLUDE_COLLECTION ||
  envConfig.ZOTERO_EXCLUDE_COLLECTION ||
  '';
export const ZOTERO_LOCAL_URL =
  process.env.ZOTERO_LOCAL_URL ||
  envConfig.ZOTERO_LOCAL_URL ||
  'http://localhost:23119';
