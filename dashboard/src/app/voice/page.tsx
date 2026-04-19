'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Captions, type CaptionLine } from './captions';
import { PreviewPane, type PreviewArtifact } from './preview-pane';
import { CostPanel } from './cost-panel';
import { DEV_PERSONA } from './personas';
import { VoiceSession, type SessionEndPayload } from './voice-session';
import { createPlayback, startMicCapture, type MicCapture, type Playback } from './audio-io';
import type { TokenUsage } from './rates';

type Status =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running' }
  | { kind: 'ending' }
  | { kind: 'ended'; payload: SessionEndPayload }
  | { kind: 'error'; message: string };

const EMPTY_USAGE: TokenUsage = { textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 };

export default function VoicePage() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [captions, setCaptions] = useState<CaptionLine[]>([]);
  const [artifacts, setArtifacts] = useState<PreviewArtifact[]>([]);
  const [costUsd, setCostUsd] = useState(0);
  const [sessionTotals, setSessionTotals] = useState<TokenUsage>(EMPTY_USAGE);
  const [muted, setMuted] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  const sessionRef = useRef<VoiceSession | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  const startedAtRef = useRef<number | null>(null);

  // Session timer
  useEffect(() => {
    if (status.kind !== 'running') return;
    const t = setInterval(() => {
      if (startedAtRef.current != null) {
        setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 500);
    return () => clearInterval(t);
  }, [status.kind]);

  // tab-close → best-effort stop
  useEffect(() => {
    function onBeforeUnload() {
      if (sessionRef.current) {
        void sessionRef.current.stop('tab_close');
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const cleanup = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    playbackRef.current?.stop();
    playbackRef.current = null;
    sessionRef.current = null;
    startedAtRef.current = null;
  }, []);

  async function handleStart() {
    setStatus({ kind: 'starting' });
    setCaptions([]);
    setArtifacts([]);
    setCostUsd(0);
    setSessionTotals(EMPTY_USAGE);
    setElapsedSec(0);
    setMuted(false);

    try {
      const mic = await startMicCapture();
      micRef.current = mic;
      const playback = createPlayback();
      playbackRef.current = playback;

      const session = new VoiceSession({
        persona: DEV_PERSONA,
        events: {
          onInputTranscript: (text, partial) => {
            setCaptions((cur) => appendOrReplacePartial(cur, 'user', text, partial));
          },
          onOutputTranscript: (text, partial) => {
            setCaptions((cur) => appendOrReplacePartial(cur, 'assistant', text, partial));
          },
          onAudio: (pcm) => {
            playback.enqueue(pcm);
          },
          onToolCall: async (call) => {
            const res = await fetch(`/api/voice/tools/dev/${call.name}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(call.args ?? {}),
            });
            const body = await res.json();
            if (body && typeof body === 'object' && 'previewUrl' in body && 'path' in body) {
              const p = String((body as { path: string }).path);
              const isDiagram = p.endsWith('.md');
              setArtifacts((cur) => [
                ...cur,
                { type: isDiagram ? 'diagram' : 'mockup', path: p },
              ]);
            }
            return body;
          },
          onCost: (c) => {
            setCostUsd(c);
            if (sessionRef.current) {
              // Pull the fresh usage totals from the tracker via session
              // (VoiceSession forwards onCost only; we query directly).
            }
          },
          onEnd: (payload) => {
            setSessionTotals(payload.usage);
            setStatus({ kind: 'ended', payload });
            cleanup();
          },
        },
      });

      sessionRef.current = session;
      mic.onFrame((pcm) => {
        if (!muted) session.sendAudio(pcm);
      });

      await session.start();
      startedAtRef.current = Date.now();
      setStatus({ kind: 'running' });
    } catch (e) {
      cleanup();
      setStatus({ kind: 'error', message: (e as Error).message });
    }
  }

  async function handleStop() {
    if (!sessionRef.current) return;
    setStatus({ kind: 'ending' });
    try {
      await sessionRef.current.stop('user_stop');
    } catch (e) {
      setStatus({ kind: 'error', message: (e as Error).message });
    }
  }

  function toggleMute() {
    setMuted((m) => {
      const next = !m;
      if (sessionRef.current) {
        if (next) sessionRef.current.mute();
        else sessionRef.current.unmute();
      }
      return next;
    });
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Voice · Dev Assistant</h1>
          <span className="rounded bg-amber-900/40 px-2 py-0.5 text-xs text-amber-200">
            Localhost only — do not expose without auth
          </span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {status.kind === 'running' && (
            <>
              <span className="font-mono text-neutral-400">
                {formatElapsed(elapsedSec)}
              </span>
              <button
                type="button"
                onClick={toggleMute}
                className={
                  'rounded px-3 py-1 text-sm ' +
                  (muted
                    ? 'bg-amber-800 text-amber-100'
                    : 'border border-neutral-700 text-neutral-300 hover:bg-neutral-800')
                }
              >
                {muted ? 'Muted' : 'Mute'}
              </button>
              <button
                type="button"
                onClick={handleStop}
                className="rounded bg-red-800 px-3 py-1 text-sm text-red-100 hover:bg-red-700"
              >
                Stop
              </button>
            </>
          )}
          {status.kind === 'idle' && (
            <button
              type="button"
              onClick={handleStart}
              className="rounded bg-blue-700 px-3 py-1 text-sm text-white hover:bg-blue-600"
            >
              Start
            </button>
          )}
          {status.kind === 'starting' && <span className="text-neutral-400">Starting…</span>}
          {status.kind === 'ending' && <span className="text-neutral-400">Ending…</span>}
          {status.kind === 'ended' && (
            <button
              type="button"
              onClick={() => setStatus({ kind: 'idle' })}
              className="rounded bg-blue-700 px-3 py-1 text-sm text-white hover:bg-blue-600"
            >
              Start new session
            </button>
          )}
        </div>
      </header>

      {status.kind === 'error' && (
        <div className="border-b border-red-900 bg-red-950/60 px-4 py-2 text-sm text-red-200">
          Error: {status.message}{' '}
          <button
            type="button"
            onClick={() => setStatus({ kind: 'idle' })}
            className="ml-2 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {status.kind === 'ended' && (
        <div className="border-b border-neutral-800 bg-neutral-900 px-4 py-2 text-sm text-neutral-300">
          Session ended — cost ${status.payload.usage ? costUsd.toFixed(4) : '0.00'}.
          {' '}
          Transcript saved.
        </div>
      )}

      <div className="grid flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] overflow-hidden">
        <div className="border-r border-neutral-800">
          <Captions lines={captions} />
        </div>
        <div>
          <PreviewPane artifacts={artifacts} />
        </div>
      </div>

      <CostPanel sessionCostUsd={costUsd} sessionTotals={sessionTotals} />
    </div>
  );
}

function appendOrReplacePartial(
  lines: CaptionLine[],
  role: 'user' | 'assistant',
  text: string,
  partial: boolean,
): CaptionLine[] {
  const out = [...lines];
  const last = out[out.length - 1];
  if (last && last.role === role && last.partial) {
    out[out.length - 1] = { role, text, ts: last.ts, partial };
    if (!partial) {
      // finalise: drop the partial flag
      out[out.length - 1] = { role, text, ts: last.ts };
    }
    return out;
  }
  out.push({ role, text, ts: new Date().toISOString(), partial: partial || undefined });
  return out;
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
