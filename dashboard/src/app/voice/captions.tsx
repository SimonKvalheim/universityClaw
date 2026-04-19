'use client';

import { useEffect, useRef, useState } from 'react';

export interface CaptionLine {
  role: 'user' | 'assistant';
  text: string;
  ts: string;
  partial?: boolean;
}

interface CaptionsProps {
  lines: CaptionLine[];
  personaLabel?: string;
}

export function Captions({ lines, personaLabel = 'Dev Assistant' }: CaptionsProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    const el = scrollRef.current;
    el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }

  async function copySession() {
    const text = lines
      .filter((l) => !l.partial)
      .map((l) => `${l.role === 'user' ? 'You' : personaLabel}: ${l.text}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore — user can manually select */
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="text-sm font-semibold text-neutral-200">Transcript</h2>
        <button
          type="button"
          onClick={copySession}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Copy session
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-2"
      >
        {lines.length === 0 ? (
          <p className="text-sm text-neutral-500">Press Start to begin.</p>
        ) : (
          <ul className="space-y-3">
            {lines.map((line, i) => (
              <li key={i} className={line.role === 'user' ? 'text-left' : 'text-right'}>
                <div
                  className={
                    (line.role === 'user'
                      ? 'bg-neutral-800/60 text-neutral-400'
                      : 'bg-blue-900/40 text-neutral-100') +
                    (line.partial ? ' opacity-60 italic' : '') +
                    ' inline-block max-w-[90%] rounded px-3 py-2 text-sm whitespace-pre-wrap'
                  }
                >
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                    {line.role === 'user' ? 'You' : personaLabel}
                  </div>
                  {line.text}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
