import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { sendPoolMessage } from './channels/telegram.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  getConceptById,
  batchCreateActivities,
  createActivityConceptLinks,
  getRecentActivityLogs,
  getActivitiesByConcept,
  getConceptsByDomain,
  getLogsByConceptAndLevel,
  getDueActivities,
  getPendingConcepts,
  getActivePlans,
  type NewLearningActivity,
} from './study/queries.js';
import { computeDueDate } from './study/sm2.js';
import type {
  GeneratedActivity,
  ActivityType,
  BloomLevel,
} from './study/types.js';
import { generateActivities } from './study/generator.js';
import {
  processCompletion,
  triggerPostSessionGeneration,
} from './study/engine.js';
import {
  computeMastery,
  computeBloomCeiling,
  computeOverallMastery,
} from './study/mastery.js';
import { RegisteredGroup } from './types.js';

const execFileAsync = promisify(execFile);

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendVoice?: (
    jid: string,
    filePath: string,
    caption?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (data.sender && data.chatJid.startsWith('tg:')) {
                    await sendPoolMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      sourceGroup,
                    );
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'voice' && data.chatJid && data.file) {
                // Voice message: resolve path, convert WAV→OGG, send via channel
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (!deps.sendVoice) {
                    logger.warn(
                      { chatJid: data.chatJid },
                      'sendVoice not available, skipping voice IPC',
                    );
                  } else {
                    // Resolve container path to host path
                    const containerFile = data.file as string;
                    if (
                      !containerFile.startsWith('/workspace/group/') ||
                      containerFile.includes('..')
                    ) {
                      logger.warn(
                        { file: containerFile, sourceGroup },
                        'Invalid voice file path',
                      );
                    } else {
                      const relative = containerFile.replace(
                        /^\/workspace\/group\//,
                        '',
                      );
                      const hostGroupDir = resolveGroupFolderPath(sourceGroup);
                      const wavPath = path.join(hostGroupDir, relative);

                      if (!wavPath.endsWith('.wav')) {
                        logger.warn(
                          { file: wavPath, sourceGroup },
                          'Voice file is not a .wav, skipping conversion',
                        );
                      } else {
                        const oggPath = wavPath.replace(/\.wav$/, '.ogg');

                        try {
                          // Convert WAV to OGG Opus for Telegram voice bubbles
                          await execFileAsync(
                            'ffmpeg',
                            [
                              '-y',
                              '-i',
                              wavPath,
                              '-c:a',
                              'libopus',
                              '-b:a',
                              '48k',
                              '-vbr',
                              'on',
                              '-application',
                              'voip',
                              oggPath,
                            ],
                            { timeout: 30_000 },
                          );

                          await deps.sendVoice(
                            data.chatJid,
                            oggPath,
                            (data.caption as string) || undefined,
                          );
                          logger.info(
                            { chatJid: data.chatJid, sourceGroup },
                            'IPC voice message sent',
                          );

                          // Clean up audio files — safe because grammY's sendVoice
                          // fully uploads the file before the promise resolves
                          fs.unlink(wavPath, () => {});
                          fs.unlink(oggPath, () => {});
                        } catch (err) {
                          logger.error(
                            { file: wavPath, sourceGroup, err },
                            'Failed to convert/send voice message',
                          );
                        }
                      }
                    }
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC voice attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For study_generated_activities
    conceptId?: string;
    activities?: GeneratedActivity[];
    // For study_generation_request
    bloomLevel?: number;
    // For study_post_session_generation
    sessionId?: string;
    // For study_complete
    activityId?: string;
    quality?: number;
    responseText?: string;
    responseTimeMs?: number;
    aiFeedback?: string;
    surface?: string;
    // For study_concept_status
    domain?: string;
    // For study_suggest_activity
    activityType?: string;
    author?: string;
    // For study_session
    limit?: number;
    preferredTypes?: string[];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'study_generated_activities': {
      const VALID_ACTIVITY_TYPES: Set<string> = new Set<ActivityType>([
        'card_review',
        'elaboration',
        'self_explain',
        'concept_map',
        'comparison',
        'case_analysis',
        'synthesis',
        'socratic',
      ]);

      if (!data.conceptId) {
        logger.error(
          { sourceGroup },
          'study_generated_activities: missing conceptId',
        );
        break;
      }

      const concept = getConceptById(data.conceptId);
      if (!concept) {
        logger.error(
          { conceptId: data.conceptId, sourceGroup },
          'study_generated_activities: concept not found in DB',
        );
        break;
      }

      const incoming = data.activities ?? [];
      const validActivities: NewLearningActivity[] = [];
      // Parallel array: relatedConceptIds for each entry in validActivities
      const relatedConceptIdsPerActivity: (string[] | undefined)[] = [];
      let skipped = 0;

      for (const activity of incoming) {
        // Validate required fields
        if (
          !activity.activityType ||
          !activity.prompt ||
          !activity.referenceAnswer ||
          activity.bloomLevel === undefined ||
          activity.bloomLevel === null
        ) {
          logger.warn(
            { activity, conceptId: data.conceptId },
            'study_generated_activities: skipping activity with missing required fields',
          );
          skipped++;
          continue;
        }

        // Validate activityType
        if (!VALID_ACTIVITY_TYPES.has(activity.activityType)) {
          logger.warn(
            { activityType: activity.activityType, conceptId: data.conceptId },
            'study_generated_activities: skipping activity with unknown activityType',
          );
          skipped++;
          continue;
        }

        // Validate bloomLevel is 1–6
        const bloom = activity.bloomLevel;
        if (!Number.isInteger(bloom) || bloom < 1 || bloom > 6) {
          logger.warn(
            { bloomLevel: bloom, conceptId: data.conceptId },
            'study_generated_activities: skipping activity with invalid bloomLevel',
          );
          skipped++;
          continue;
        }

        validActivities.push({
          id: crypto.randomUUID(),
          conceptId: data.conceptId,
          activityType: activity.activityType,
          prompt: activity.prompt,
          referenceAnswer: activity.referenceAnswer,
          bloomLevel: activity.bloomLevel,
          difficultyEstimate: activity.difficultyEstimate ?? 5,
          cardType: activity.cardType ?? null,
          sourceNotePath: activity.sourceNotePath ?? null,
          sourceChunkHash: activity.sourceChunkHash ?? null,
          generatedAt: new Date().toISOString(),
          author: 'system',
          easeFactor: 2.5,
          intervalDays: 1,
          repetitions: 0,
          dueAt: computeDueDate(1),
          masteryState: 'new',
        });
        relatedConceptIdsPerActivity.push(activity.relatedConceptIds);
      }

      batchCreateActivities(validActivities);

      // Create concept links for activities that reference related concepts
      for (let idx = 0; idx < validActivities.length; idx++) {
        const relatedIds = relatedConceptIdsPerActivity[idx];
        if (relatedIds && relatedIds.length > 0) {
          createActivityConceptLinks(
            validActivities[idx].id as string,
            relatedIds,
          );
        }
      }

      logger.info(
        `IPC: inserted ${validActivities.length} activities for concept ${data.conceptId} (${skipped} skipped)`,
      );
      break;
    }

    case 'study_generation_request': {
      if (!data.conceptId) {
        logger.error(
          { sourceGroup },
          'study_generation_request: missing conceptId',
        );
        break;
      }
      const bloomLevel = (data.bloomLevel ??
        1) as import('./study/types.js').BloomLevel;
      try {
        await generateActivities(data.conceptId, bloomLevel);
      } catch (err) {
        logger.error(
          { err, conceptId: data.conceptId, bloomLevel },
          'study_generation_request: generateActivities threw',
        );
      }
      break;
    }

    case 'study_post_session_generation': {
      if (!data.sessionId) {
        logger.error(
          { sourceGroup },
          'study_post_session_generation: missing sessionId',
        );
        break;
      }
      try {
        await triggerPostSessionGeneration(data.sessionId);
      } catch (err) {
        logger.error(
          { err, sessionId: data.sessionId },
          'study_post_session_generation: triggerPostSessionGeneration threw',
        );
      }
      break;
    }

    case 'study_complete': {
      if (!data.activityId || typeof data.activityId !== 'string') {
        logger.error(
          { sourceGroup },
          'study_complete: missing or invalid activityId',
        );
        break;
      }
      if (
        data.quality === undefined ||
        !Number.isInteger(data.quality) ||
        data.quality < 0 ||
        data.quality > 5
      ) {
        logger.error(
          { sourceGroup, quality: data.quality },
          'study_complete: missing or invalid quality (must be integer 0-5)',
        );
        break;
      }
      try {
        const result = processCompletion({
          activityId: data.activityId,
          quality: data.quality,
          sessionId: data.sessionId,
          responseText: data.responseText,
          responseTimeMs: data.responseTimeMs,
          evaluationMethod: data.aiFeedback ? 'ai_evaluated' : 'self_rated',
          aiQuality: data.aiFeedback ? data.quality : undefined,
          aiFeedback: data.aiFeedback,
          surface: data.surface ?? 'dashboard_chat',
        });
        if (result.generationNeeded && result.advancement) {
          try {
            await generateActivities(
              result.advancement.conceptId,
              result.advancement.newCeiling as BloomLevel,
            );
          } catch (err) {
            logger.error(
              { err, conceptId: result.advancement.conceptId },
              'study_complete: generateActivities threw',
            );
          }
        }
        logger.info(
          `study_complete: activityId=${data.activityId}, quality=${data.quality}, advancement=${result.advancement ? 'yes' : 'no'}`,
        );
      } catch (err) {
        logger.error(
          { err, activityId: data.activityId },
          'study_complete: processCompletion threw',
        );
      }
      break;
    }

    case 'study_concept_status': {
      if (!data.conceptId && !data.domain) {
        logger.warn(
          { sourceGroup },
          'study_concept_status: neither conceptId nor domain provided',
        );
        break;
      }
      const ipcBaseDir = path.join(DATA_DIR, 'ipc');
      const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
      fs.mkdirSync(responsesDir, { recursive: true });
      const responseFile = path.join(
        responsesDir,
        `concept-status-${Date.now()}.json`,
      );

      if (data.conceptId) {
        const concept = getConceptById(data.conceptId);
        if (!concept) {
          logger.warn(
            { conceptId: data.conceptId, sourceGroup },
            'study_concept_status: concept not found',
          );
          break;
        }
        const recentLogs = getRecentActivityLogs(data.conceptId, 10);
        const masteryInput = recentLogs.map((log) => ({
          bloomLevel: log.bloomLevel as BloomLevel,
          quality: log.quality,
          reviewedAt: log.reviewedAt,
        }));
        const levels = computeMastery(masteryInput);
        const bloomCeiling = computeBloomCeiling(levels);
        const overallMastery = computeOverallMastery(levels);
        fs.writeFileSync(
          responseFile,
          JSON.stringify({
            type: 'concept_status',
            concept,
            recentLogs,
            masteryLevels: levels,
            bloomCeiling,
            overallMastery,
          }),
        );
      } else if (data.domain) {
        const concepts = getConceptsByDomain(data.domain);
        const summaries = concepts.map((concept) => {
          const allLogs = getLogsByConceptAndLevel(concept.id);
          const masteryInput = allLogs.map((log) => ({
            bloomLevel: log.bloomLevel as BloomLevel,
            quality: log.quality,
            reviewedAt: log.reviewedAt,
          }));
          const levels = computeMastery(masteryInput);
          const bloomCeiling = computeBloomCeiling(levels);
          const overallMastery = computeOverallMastery(levels);
          return {
            concept,
            masteryLevels: levels,
            bloomCeiling,
            overallMastery,
          };
        });
        fs.writeFileSync(
          responseFile,
          JSON.stringify({
            type: 'domain_status',
            domain: data.domain,
            summaries,
          }),
        );
      }
      break;
    }

    case 'study_suggest_activity': {
      const VALID_SUGGEST_TYPES: Set<string> = new Set<ActivityType>([
        'card_review',
        'elaboration',
        'self_explain',
        'concept_map',
        'comparison',
        'case_analysis',
        'synthesis',
        'socratic',
      ]);

      if (
        !data.conceptId ||
        !data.activityType ||
        !data.prompt ||
        data.bloomLevel === undefined
      ) {
        logger.error(
          { sourceGroup },
          'study_suggest_activity: missing required fields (conceptId, activityType, prompt, bloomLevel)',
        );
        break;
      }

      if (!VALID_SUGGEST_TYPES.has(data.activityType)) {
        logger.error(
          { activityType: data.activityType, sourceGroup },
          'study_suggest_activity: invalid activityType',
        );
        break;
      }

      if (
        !Number.isInteger(data.bloomLevel) ||
        data.bloomLevel < 1 ||
        data.bloomLevel > 6
      ) {
        logger.error(
          { bloomLevel: data.bloomLevel, sourceGroup },
          'study_suggest_activity: bloomLevel must be integer 1-6',
        );
        break;
      }

      const suggestActivity: NewLearningActivity = {
        id: crypto.randomUUID(),
        conceptId: data.conceptId,
        activityType: data.activityType as ActivityType,
        prompt: data.prompt,
        bloomLevel: data.bloomLevel,
        author: (data.author ?? 'student') as 'student' | 'system',
        referenceAnswer: '',
        difficultyEstimate: 5,
        generatedAt: new Date().toISOString(),
        dueAt: new Date().toISOString().split('T')[0],
        easeFactor: 2.5,
        intervalDays: 1,
        repetitions: 0,
        masteryState: 'new',
        cardType: null,
        sourceNotePath: null,
        sourceChunkHash: null,
      };

      batchCreateActivities([suggestActivity]);
      createActivityConceptLinks(suggestActivity.id as string, [
        data.conceptId,
      ]);

      logger.info(
        `study_suggest_activity: conceptId=${data.conceptId}, type=${data.activityType}, bloomLevel=${data.bloomLevel}`,
      );
      break;
    }

    case 'study_session': {
      const ipcBaseDir = path.join(DATA_DIR, 'ipc');
      const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
      fs.mkdirSync(responsesDir, { recursive: true });
      const responseFile = path.join(
        responsesDir,
        `session-${Date.now()}.json`,
      );

      const limit = typeof data.limit === 'number' ? data.limit : 20;
      const dueActivities = getDueActivities();

      // Filter by preferred types if specified
      let filtered = dueActivities;
      if (
        Array.isArray(data.preferredTypes) &&
        data.preferredTypes.length > 0
      ) {
        const typeSet = new Set(data.preferredTypes);
        filtered = dueActivities.filter((a) => typeSet.has(a.activityType));
      }

      // Limit results
      const limited = filtered.slice(0, limit);

      // Enrich with concept titles
      const enriched = limited.map((a) => {
        const concept = getConceptById(a.conceptId);
        return {
          id: a.id,
          conceptTitle: concept?.title ?? 'Unknown',
          activityType: a.activityType,
          bloomLevel: a.bloomLevel,
          dueAt: a.dueAt,
          prompt: a.prompt,
        };
      });

      // Get pending concepts count and active plans
      const pendingConcepts = getPendingConcepts();
      const activePlans = getActivePlans();

      fs.writeFileSync(
        responseFile,
        JSON.stringify({
          type: 'session_summary',
          dueCount: dueActivities.length,
          pendingConceptCount: pendingConcepts.length,
          activePlanCount: activePlans.length,
          dueActivities: enriched,
          activePlans: activePlans.map((p) => ({
            id: p.id,
            title: p.title,
            status: p.status,
          })),
        }),
      );

      logger.info(
        {
          sourceGroup,
          dueCount: dueActivities.length,
          returned: enriched.length,
        },
        'study_session: wrote session summary',
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
