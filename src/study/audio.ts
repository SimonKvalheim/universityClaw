import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { getConceptById } from './queries.js';

// ====================================================================
// Types
// ====================================================================

export interface AudioScriptOptions {
  conceptIds: string[];
  contentType: 'summary' | 'review_primer' | 'weekly_digest';
  targetDurationMinutes?: number;
}

// ====================================================================
// generateAudioScript
// ====================================================================

export async function generateAudioScript(
  options: AudioScriptOptions,
): Promise<void> {
  const { conceptIds, contentType, targetDurationMinutes = 5 } = options;

  // Fetch concept data for each ID
  const concepts = conceptIds
    .map((id) => getConceptById(id))
    .filter(
      (c): c is NonNullable<ReturnType<typeof getConceptById>> => c != null,
    );

  const conceptSummaries = concepts
    .map((c) => {
      const overallMastery = Math.max(
        c.masteryL1 ?? 0,
        c.masteryL2 ?? 0,
        c.masteryL3 ?? 0,
        c.masteryL4 ?? 0,
        c.masteryL5 ?? 0,
        c.masteryL6 ?? 0,
      );
      return `- ${c.title} (domain: ${c.domain ?? 'unknown'}, mastery: ${overallMastery.toFixed(2)})`;
    })
    .join('\n');

  const prompt = [
    `Generate a conversational audio script about these concepts for a ${contentType.replace(/_/g, ' ')} of approximately ${targetDurationMinutes} minutes.`,
    '',
    'Concepts:',
    conceptSummaries,
    '',
    'Write in natural spoken language suitable for text-to-speech. No markdown, no bullet points, no headers.',
    'Use smooth transitions between concepts and include rhetorical questions where appropriate.',
    `Target word count: ~${Math.round(targetDurationMinutes * 150)} words.`,
  ].join('\n');

  const tasksDir = path.join(DATA_DIR, 'ipc', 'study-generator', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const taskFile = path.join(tasksDir, `audio_script_${Date.now()}.json`);
  fs.writeFileSync(
    taskFile,
    JSON.stringify({
      type: 'study_generation_request',
      promptOverride: true,
      audioScript: true,
      conceptIds,
      contentType,
      prompt,
    }),
  );

  logger.info(
    { taskFile, conceptIds, contentType },
    'generateAudioScript: IPC task written',
  );
}

// ====================================================================
// synthesizeAudio
// ====================================================================

export async function synthesizeAudio(
  script: string,
  outputPath: string,
): Promise<string> {
  const tempPath = outputPath + '.tmp';

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: script,
        voice: 'alloy',
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new Error(`TTS API error ${response.status}: ${body}`);
    }

    const audioBuffer = await response.arrayBuffer();
    fs.writeFileSync(tempPath, Buffer.from(audioBuffer));
    fs.renameSync(tempPath, outputPath);

    logger.info({ outputPath }, 'synthesizeAudio: audio written');
    return outputPath;
  } catch (err) {
    // Clean up temp file if it exists
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}
