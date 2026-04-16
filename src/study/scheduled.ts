import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config.js';
import { createTask, getTaskById } from '../db.js';
import { logger } from '../logger.js';

// ============================================================
// Prompt constants
// ============================================================

export const MORNING_STUDY_PROMPT = `You are Mr. Rogers, a personal university teaching assistant. This is the daily morning study check.

Query the study database at /workspace/project/store/messages.db and do the following:

1. Count learning_activities where due_at <= date('now') and status != 'completed' (due today or overdue).
2. Count concepts where status = 'pending_approval' (awaiting review).
3. Check study_plans where status = 'active' for any next_checkpoint_at within the next 2 days.

Then send a morning study message to the chat. Keep it to 3–5 lines. Use Telegram-friendly formatting (bold with *, no Markdown headers). Example structure:
- How many activities are due (or "you're all caught up!")
- Any pending concepts to review
- Any plan checkpoints coming up soon

If there are between 3 and 5 card_review activities due, offer to start a quick review session right now.`;

export const WEEKLY_PROGRESS_PROMPT = `You are Mr. Rogers, a personal university teaching assistant. This is the weekly progress review (runs every Sunday evening).

Query the study database at /workspace/project/store/messages.db:

1. From activity_log: count entries where completed_at >= datetime('now', '-7 days'). Break down by activity_type and bloom_level (Bloom distribution).
2. From concepts: show how many moved from 'pending_approval' → 'active' or 'mastered' in the past 7 days.
3. From study_plans where status = 'active': show plan title, percent complete (completed_checkpoints / total_checkpoints), and next_checkpoint_at.
4. Look for concepts at bloom_level >= 4 that share a domain — flag as synthesis opportunities.

Write a concise weekly summary (6–10 lines, Telegram formatting). Highlight what went well, what areas need attention, and one actionable suggestion for the coming week.`;

export const MONTHLY_MASTERY_PROMPT = `You are Mr. Rogers, a personal university teaching assistant. This is the monthly mastery review (runs on the 1st of each month).

Query the study database at /workspace/project/store/messages.db for a comprehensive mastery snapshot:

1. For each concept: title, current bloom_level, last activity completion date, total activities completed vs. generated.
2. Detect knowledge decay: concepts with no activity_log entry in the past 30 days that are not 'mastered' — flag these.
3. Growth trajectory: compare bloom_level distribution now vs. 30 days ago (use activity_log timestamps as a proxy).
4. Study plans: for each active plan show title, status, days since last checkpoint, and whether the plan is on track.

Write a monthly mastery report (8–12 lines, Telegram formatting). Cover: top mastered concepts, areas of decay risk, overall growth trend, and a recommended focus area for the coming month.`;

// ============================================================
// Task definition type
// ============================================================

export interface StudyTaskDefinition {
  id: string;
  prompt: string;
  cronExpression: string;
  groupFolder: string;
  chatJid: string;
  script?: string | null;
}

// ============================================================
// Task definitions factory
// ============================================================

export function getStudyTaskDefinitions(
  mainChatJid: string,
): StudyTaskDefinition[] {
  return [
    {
      id: 'study-daily-morning',
      prompt: MORNING_STUDY_PROMPT,
      cronExpression: '0 7 * * *',
      groupFolder: 'telegram_main',
      chatJid: mainChatJid,
    },
    {
      id: 'study-weekly-progress',
      prompt: WEEKLY_PROGRESS_PROMPT,
      cronExpression: '0 18 * * 0',
      groupFolder: 'telegram_main',
      chatJid: mainChatJid,
    },
    {
      id: 'study-monthly-mastery',
      prompt: MONTHLY_MASTERY_PROMPT,
      cronExpression: '0 10 1 * *',
      groupFolder: 'telegram_main',
      chatJid: mainChatJid,
    },
  ];
}

// ============================================================
// Registration
// ============================================================

export function registerStudyScheduledTasks(mainChatJid: string): void {
  const definitions = getStudyTaskDefinitions(mainChatJid);
  for (const def of definitions) {
    const existing = getTaskById(def.id);
    if (existing) {
      logger.debug(
        { taskId: def.id },
        'Study scheduled task already exists, skipping',
      );
      continue;
    }
    const interval = CronExpressionParser.parse(def.cronExpression, {
      tz: TIMEZONE,
    });
    const nextRun = interval.next().toISOString();
    createTask({
      id: def.id,
      group_folder: def.groupFolder,
      chat_jid: def.chatJid,
      prompt: def.prompt,
      script: def.script || null,
      schedule_type: 'cron',
      schedule_value: def.cronExpression,
      context_mode: 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info({ taskId: def.id, nextRun }, 'Registered study scheduled task');
  }
}
