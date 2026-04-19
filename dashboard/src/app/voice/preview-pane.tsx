'use client';

import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

export interface PreviewArtifact {
  type: 'mockup' | 'diagram';
  path: string;
}

interface PreviewPaneProps {
  artifacts: PreviewArtifact[];
}

type Tab = 'mockup' | 'diagram';

export function PreviewPane({ artifacts }: PreviewPaneProps) {
  const [tab, setTab] = useState<Tab>('mockup');

  const latestMockup = [...artifacts].reverse().find((a) => a.type === 'mockup');
  const latestDiagram = [...artifacts].reverse().find((a) => a.type === 'diagram');

  useEffect(() => {
    if (latestMockup && tab === 'mockup') return;
    if (latestDiagram && tab === 'diagram') return;
    if (latestMockup) setTab('mockup');
    else if (latestDiagram) setTab('diagram');
  }, [latestMockup, latestDiagram, tab]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <button
          type="button"
          className={
            'rounded px-2 py-1 text-xs ' +
            (tab === 'mockup'
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800')
          }
          onClick={() => setTab('mockup')}
        >
          Mockup
        </button>
        <button
          type="button"
          className={
            'rounded px-2 py-1 text-xs ' +
            (tab === 'diagram'
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800')
          }
          onClick={() => setTab('diagram')}
        >
          Diagram
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'mockup' ? (
          latestMockup ? (
            <iframe
              key={latestMockup.path}
              sandbox="allow-scripts"
              src={`/voice/preview?file=${encodeURIComponent(latestMockup.path)}`}
              className="h-full w-full border-0 bg-white"
              title="Mockup preview"
            />
          ) : (
            <EmptyState label="No mockup yet — ask the assistant to write one." />
          )
        ) : latestDiagram ? (
          <DiagramView key={latestDiagram.path} filePath={latestDiagram.path} />
        ) : (
          <EmptyState label="No diagram yet — ask for a flowchart or sequence diagram." />
        )}
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-neutral-500">
      {label}
    </div>
  );
}

function DiagramView({ filePath }: { filePath: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      setError(null);
      try {
        const res = await fetch(
          `/voice/preview?file=${encodeURIComponent(filePath)}`,
        );
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const md = await res.text();
        const match = md.match(/```mermaid\n([\s\S]*?)\n```/);
        const mermaidSource = match ? match[1] : md.trim();
        if (!mermaidSource) throw new Error('no mermaid source found');
        mermaid.initialize({ startOnLoad: false, theme: 'dark' });
        const id = 'm_' + Math.random().toString(36).slice(2);
        const { svg } = await mermaid.render(id, mermaidSource);
        if (cancelled) return;
        if (ref.current) ref.current.innerHTML = svg;
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    render();
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div className="h-full w-full overflow-auto bg-neutral-900 p-4">
      {error ? (
        <p className="text-sm text-red-400">Diagram error: {error}</p>
      ) : (
        <div ref={ref} className="mermaid-diagram text-neutral-100" />
      )}
    </div>
  );
}
