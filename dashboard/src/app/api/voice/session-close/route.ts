import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '../../../../lib/db/index';
import { voice_sessions } from '../../../../lib/db/schema';
import { computeCostUsd, RATES } from '../../../voice/rates';

interface SessionCloseBody {
  voiceSessionId: string;
  persona: 'dev';
  startedAt: string;
  endedAt: string;
  transcript: Array<{ role: 'user' | 'assistant'; text: string; ts: string }>;
  usage: { textIn: number; textOut: number; audioIn: number; audioOut: number };
  artifacts: string[];
  endReason: 'user_stop' | 'tab_close' | 'soft_cap' | 'hard_cap' | 'ws_drop';
}

function isLoopback(host: string | null): boolean {
  if (!host) return false;
  let h = host.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end >= 0 ? h.slice(1, end) : h;
  } else {
    h = h.split(':')[0];
  }
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function getRepoRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith(path.sep + 'dashboard') || cwd.endsWith('/dashboard')
    ? path.resolve(cwd, '..')
    : cwd;
}

function formatFilename(sid: string, endedAtIso: string): string {
  // UTC timestamp, format YYYY-MM-DD-HHmm-<short-sid>.md
  const d = new Date(endedAtIso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const shortSid = sid.slice(0, 8).replace(/[^a-zA-Z0-9-]/g, '');
  return `${yyyy}-${mm}-${dd}-${hh}${mi}-${shortSid}.md`;
}

function buildTranscriptMarkdown(
  body: SessionCloseBody,
  durationSeconds: number,
  costUsd: number,
): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`voiceSessionId: ${body.voiceSessionId}`);
  lines.push(`persona: ${body.persona}`);
  lines.push(`startedAt: ${body.startedAt}`);
  lines.push(`endedAt: ${body.endedAt}`);
  lines.push(`durationSeconds: ${durationSeconds}`);
  lines.push(`costUsd: ${costUsd}`);
  if (body.artifacts.length > 0) {
    lines.push('artifacts:');
    for (const a of body.artifacts) lines.push(`  - ${a}`);
  }
  lines.push('---');
  lines.push('');
  for (const turn of body.transcript) {
    const header = turn.role === 'user' ? '## User' : '## Assistant';
    lines.push(header);
    lines.push('');
    if (turn.role === 'user') {
      for (const row of turn.text.split('\n')) lines.push('> ' + row);
    } else {
      lines.push(turn.text);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function POST(req: Request) {
  if (!isLoopback(req.headers.get('host'))) {
    return NextResponse.json(
      { error: 'voice endpoints are localhost-only' },
      { status: 403 },
    );
  }

  let raw: SessionCloseBody;
  try {
    raw = (await req.json()) as SessionCloseBody;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (!raw || typeof raw.voiceSessionId !== 'string' || !raw.voiceSessionId) {
    return NextResponse.json({ error: 'voiceSessionId required' }, { status: 400 });
  }
  if (raw.persona !== 'dev') {
    return NextResponse.json({ error: 'persona must be "dev"' }, { status: 400 });
  }
  const startedAtMs = Date.parse(raw.startedAt);
  const endedAtMs = Date.parse(raw.endedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return NextResponse.json({ error: 'invalid timestamps' }, { status: 400 });
  }
  if (endedAtMs < startedAtMs) {
    return NextResponse.json({ error: 'endedAt before startedAt' }, { status: 400 });
  }

  const durationSeconds = Math.max(0, Math.round((endedAtMs - startedAtMs) / 1000));
  const usage = raw.usage ?? { textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 };
  const costUsd = computeCostUsd(usage, RATES);

  const repoRoot = getRepoRoot();

  let transcriptPathRel: string | null = null;
  if (Array.isArray(raw.transcript) && raw.transcript.length > 0) {
    const dir = path.join(repoRoot, 'docs', 'superpowers', 'brainstorm-sessions');
    await fs.mkdir(dir, { recursive: true });
    const filename = formatFilename(raw.voiceSessionId, raw.endedAt);
    const abs = path.join(dir, filename);
    const md = buildTranscriptMarkdown(raw, durationSeconds, costUsd);
    await fs.writeFile(abs, md, 'utf8');
    transcriptPathRel = path.relative(repoRoot, abs);
  }

  const db = getDb();
  try {
    await db.insert(voice_sessions).values({
      id: raw.voiceSessionId,
      persona: raw.persona,
      started_at: raw.startedAt,
      ended_at: raw.endedAt,
      duration_seconds: durationSeconds,
      text_tokens_in: usage.textIn ?? 0,
      text_tokens_out: usage.textOut ?? 0,
      audio_tokens_in: usage.audioIn ?? 0,
      audio_tokens_out: usage.audioOut ?? 0,
      cost_usd: costUsd,
      rates_version: RATES.version,
      transcript_path: transcriptPathRel,
      artifacts: JSON.stringify(raw.artifacts ?? []),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'db insert failed: ' + (err as Error).message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    transcriptPath: transcriptPathRel,
    costUsd,
  });
}
