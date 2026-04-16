import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

const projectRoot = path.join(process.cwd(), '..');

function ipcTaskDir(): string {
  return path.join(projectRoot, 'data', 'ipc', 'study-generator', 'tasks');
}

export async function POST(request: Request) {
  const body = await request.json();
  const { conceptId, activityType, prompt, bloomLevel } = body;

  if (!conceptId || !activityType || !prompt || !bloomLevel) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const validTypes = [
    'card_review',
    'elaboration',
    'self_explain',
    'concept_map',
    'synthesis',
    'socratic',
    'comparison',
    'case_analysis',
  ];
  if (!validTypes.includes(activityType)) {
    return NextResponse.json({ error: 'Invalid activity type' }, { status: 400 });
  }

  if (typeof bloomLevel !== 'number' || bloomLevel < 1 || bloomLevel > 6) {
    return NextResponse.json({ error: 'Bloom level must be 1-6' }, { status: 400 });
  }

  const dir = ipcTaskDir();
  fs.mkdirSync(dir, { recursive: true });

  const payload = {
    type: 'study_suggest_activity',
    conceptId,
    activityType,
    prompt,
    bloomLevel,
    author: 'student',
  };

  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `suggest-${ts}-${rand}.json`;
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload));

  return NextResponse.json({ success: true });
}
