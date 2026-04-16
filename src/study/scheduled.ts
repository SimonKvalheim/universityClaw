import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config.js';
import { createTask, getTaskById } from '../db.js';
import { logger } from '../logger.js';

// ============================================================
// Prompt constants
// ============================================================

export const MORNING_STUDY_PROMPT = `You are Mr. Rogers, a personal university teaching assistant. This is the daily morning study check.

Query the study database at /workspace/project/store/messages.db and do the following:

1. Count due activities: SELECT count(*) FROM learning_activities WHERE due_at <= date('now')
2. Count pending concepts: SELECT count(*) FROM concepts WHERE status = 'pending'
3. Check plan checkpoints: SELECT title, next_checkpoint_at FROM study_plans WHERE status = 'active' AND next_checkpoint_at <= date('now', '+2 days')

Then send a morning study message to the chat. Keep it to 3–5 lines. Use Telegram-friendly formatting (bold with *, no Markdown headers). Example structure:
- How many activities are due (or "you're all caught up!")
- Any pending concepts to review on the dashboard
- Any plan checkpoints coming up soon

If there are between 3 and 5 card_review activities due, offer to start a quick review session right now.`;

export const WEEKLY_PROGRESS_PROMPT = `You are Mr. Rogers, a personal university teaching assistant. This is the weekly progress review (runs every Sunday evening).

Query the study database at /workspace/project/store/messages.db:

1. Activity this week: SELECT count(*) FROM activity_log WHERE reviewed_at >= date('now', '-7 days')
   Bloom distribution: SELECT bloom_level, count(*) FROM activity_log WHERE reviewed_at >= date('now', '-7 days') GROUP BY bloom_level
   Average quality: SELECT avg(quality) FROM activity_log WHERE reviewed_at >= date('now', '-7 days')
2. Concept progression: SELECT count(*) FROM concepts WHERE status = 'active' AND created_at >= date('now', '-7 days') (recently approved concepts)
3. Active plans: SELECT title, status, next_checkpoint_at FROM study_plans WHERE status = 'active'
   Plan progress: for each plan, count concepts at target bloom via study_plan_concepts joined with concepts (bloom_ceiling >= target_bloom)
4. Synthesis opportunities: SELECT title, domain, bloom_ceiling FROM concepts WHERE bloom_ceiling >= 4 AND status = 'active' ORDER BY domain — flag domains with 2+ concepts at bloom_ceiling >= 4

Write a concise weekly summary (6–10 lines, Telegram formatting). Highlight what went well, what areas need attention, and one actionable suggestion for the coming week.`;

export const MONTHLY_MASTERY_PROMPT = `You are Mr. Rogers, a personal university teaching assistant. This is the monthly mastery review (runs on the 1st of each month).

Query the study database at /workspace/project/store/messages.db for a comprehensive mastery snapshot:

1. All active concepts: SELECT title, domain, bloom_ceiling, mastery_overall, last_activity_at FROM concepts WHERE status = 'active' ORDER BY domain, mastery_overall DESC
2. Decay detection: concepts with no recent activity — SELECT c.title, c.domain, c.bloom_ceiling, c.last_activity_at FROM concepts c WHERE c.status = 'active' AND (c.last_activity_at IS NULL OR c.last_activity_at < date('now', '-30 days')) — flag these as at risk of forgetting
3. Growth trajectory: bloom_ceiling distribution — SELECT bloom_ceiling, count(*) FROM concepts WHERE status = 'active' GROUP BY bloom_ceiling
   Monthly activity volume: SELECT strftime('%Y-%m', reviewed_at) as month, count(*) FROM activity_log GROUP BY month ORDER BY month DESC LIMIT 3
4. Plan status: SELECT title, status, next_checkpoint_at FROM study_plans WHERE status = 'active'

Write a monthly mastery report (8–12 lines, Telegram formatting). Cover: highest mastery concepts, areas of decay risk, overall growth trend, and a recommended focus area for the coming month.`;

export const AUDIO_PRIMER_PROMPT = `You are Mr. Rogers, a personal university teaching assistant. This is the daily audio review primer task (06:00).

1. Check if there are due activities today:
   SELECT count(*) FROM learning_activities WHERE due_at <= date('now')

2. If there are 3+ due activities, generate a brief audio review primer:
   - Get the titles and domains of concepts with due activities:
     SELECT DISTINCT c.title, c.domain FROM concepts c
     JOIN learning_activities la ON la.concept_id = c.id
     WHERE la.due_at <= date('now') AND c.status = 'active'
   - Write a 2-3 minute conversational audio script covering the key points
   - Output via study_audio_script IPC:
     echo '{"type":"study_audio_script","conceptIds":["<id1>","<id2>"],"script":"<your script>","contentType":"review_primer"}' > /workspace/ipc/tasks/audio_primer_$(date +%s).json

3. If there are fewer than 3 due activities, skip audio generation.

4. If an audio file was recently generated (check /workspace/project/data/audio/ for files from today), send it to the chat with a brief message like "Here is a quick audio review of today's concepts. Listen while you get ready!"

Keep any text messages concise. Use Telegram formatting (*bold*, no ## headings).`;

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
    {
      id: 'study-audio-primer',
      prompt: AUDIO_PRIMER_PROMPT,
      cronExpression: '0 6 * * *',
      groupFolder: 'telegram_main',
      chatJid: mainChatJid,
    },
    {
      id: 'study-sqlite-backup',
      prompt: `Run the following backup commands in your bash sandbox. Execute exactly these commands:

\`\`\`bash
DB_PATH="/workspace/project/store/messages.db"
BACKUP_DIR="/workspace/project/store/backups"
mkdir -p "$BACKUP_DIR"
TODAY=$(date +%Y-%m-%d)
BACKUP_FILE="$BACKUP_DIR/messages-$TODAY.db"

# Use SQLite .backup for atomic consistency
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Rotate: keep last 7 daily backups
ls -1t "$BACKUP_DIR"/messages-*.db 2>/dev/null | tail -n +8 | xargs rm -f 2>/dev/null || true

# Report result
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backup complete: $BACKUP_FILE ($SIZE)"
\`\`\`

After running, report the result. If any command fails, report the exact error. Do NOT modify the database or any other files.`,
      cronExpression: '0 3 * * *',
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
