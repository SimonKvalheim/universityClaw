'use client';

import { useState } from 'react';
import { useRagStatus, type RagDocument } from '@/hooks/useRagStatus';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncate(str: string | null, len: number): string {
  if (!str) return '(no summary)';
  return str.length > len ? str.slice(0, len) + '\u2026' : str;
}

function Pill({
  count,
  label,
  color,
}: {
  count: number;
  label: string;
  color: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${color}`}
    >
      {count} {label}
    </span>
  );
}

function DocRow({ doc }: { doc: RagDocument }) {
  const summary = truncate(doc.content_summary || doc.file_path, 80);
  return (
    <div className="flex items-start justify-between gap-2 py-1.5 border-b border-gray-800 last:border-0">
      <div className="min-w-0">
        <p className="text-sm text-gray-300 truncate">{summary}</p>
        {doc.error_msg && (
          <p className="text-xs text-red-400 mt-0.5">{doc.error_msg}</p>
        )}
      </div>
      <span className="text-xs text-gray-600 shrink-0" title={doc.updated_at}>
        {relativeTime(doc.updated_at)}
      </span>
    </div>
  );
}

export function RagStatusCard() {
  const { data, error, isLoading, retryFailed } = useRagStatus();
  const [showActive, setShowActive] = useState(false);
  const [retrying, setRetrying] = useState(false);

  if (isLoading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
          RAG Index
        </h3>
        <p className="text-sm text-gray-500 mt-2">Loading...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
            RAG Index
          </h3>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-900 text-red-300">
            Offline
          </span>
        </div>
        <p className="text-2xl font-bold text-red-400">Unreachable</p>
        <p className="text-sm text-gray-500 mt-1">
          {error || 'Cannot connect to LightRAG'}
        </p>
      </div>
    );
  }

  const { counts, health, pipeline, failedDocs, processingDocs } = data;
  const isBusy = health.pipeline_busy || pipeline.busy;
  const activeCount =
    counts.processing + counts.pending + (counts.preprocessed || 0);

  async function handleRetry() {
    setRetrying(true);
    try {
      await retryFailed();
    } catch {
      // error is visible via status update
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 col-span-1 md:col-span-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
            RAG Index
          </h3>
          {isBusy && (
            <span className="inline-flex items-center gap-1.5 text-xs text-blue-300">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              Indexing\u2026
            </span>
          )}
        </div>
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
            isBusy
              ? 'bg-blue-900 text-blue-300'
              : 'bg-green-900 text-green-300'
          }`}
        >
          {isBusy ? 'Processing' : 'Idle'}
        </span>
      </div>

      {/* Summary pills */}
      <div className="flex flex-wrap gap-2 mb-4">
        <Pill
          count={counts.processed}
          label="processed"
          color="bg-green-900/60 text-green-300"
        />
        {counts.processing > 0 && (
          <Pill
            count={counts.processing}
            label="processing"
            color="bg-blue-900/60 text-blue-300"
          />
        )}
        {(counts.preprocessed || 0) > 0 && (
          <Pill
            count={counts.preprocessed}
            label="preprocessed"
            color="bg-cyan-900/60 text-cyan-300"
          />
        )}
        {counts.pending > 0 && (
          <Pill
            count={counts.pending}
            label="pending"
            color="bg-yellow-900/60 text-yellow-300"
          />
        )}
        {counts.failed > 0 && (
          <Pill
            count={counts.failed}
            label="failed"
            color="bg-red-900/60 text-red-300"
          />
        )}
      </div>

      {/* Pipeline progress */}
      {isBusy && pipeline.latest_message && (
        <div className="mb-4 px-3 py-2 rounded bg-gray-800/50 border border-gray-700/50">
          <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
            <span>
              Batch {pipeline.cur_batch}/{pipeline.batchs}
            </span>
            {pipeline.job_start && (
              <span>started {relativeTime(pipeline.job_start)}</span>
            )}
          </div>
          <p className="text-xs text-gray-300 truncate">
            {pipeline.latest_message}
          </p>
        </div>
      )}

      {/* Model config */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mb-4">
        <span>
          LLM:{' '}
          <span className="text-gray-400">
            {health.llm_model}
          </span>
          <span className="text-gray-600"> ({health.llm_binding})</span>
        </span>
        <span>
          Embed:{' '}
          <span className="text-gray-400">
            {health.embedding_model}
          </span>
          <span className="text-gray-600"> ({health.embedding_binding})</span>
        </span>
      </div>

      {/* Failed documents */}
      {failedDocs.length > 0 && (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-medium text-red-400 uppercase tracking-wide">
              Failed ({failedDocs.length})
            </h4>
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="text-xs px-2.5 py-1 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 disabled:opacity-50 transition-colors"
            >
              {retrying ? 'Retrying\u2026' : 'Retry all'}
            </button>
          </div>
          <div className="rounded bg-gray-800/40 px-3">
            {failedDocs.map((doc) => (
              <DocRow key={doc.id} doc={doc} />
            ))}
          </div>
        </div>
      )}

      {/* Processing / Pending documents */}
      {activeCount > 0 && (
        <div>
          <button
            onClick={() => setShowActive(!showActive)}
            className="flex items-center gap-1 text-xs font-medium text-gray-400 uppercase tracking-wide hover:text-gray-300 transition-colors"
          >
            <span className="text-gray-600">
              {showActive ? '\u25BE' : '\u25B8'}
            </span>
            In progress ({activeCount})
          </button>
          {showActive && processingDocs.length > 0 && (
            <div className="mt-2 rounded bg-gray-800/40 px-3">
              {processingDocs.map((doc) => (
                <DocRow key={doc.id} doc={doc} />
              ))}
            </div>
          )}
          {showActive && processingDocs.length === 0 && (
            <p className="mt-2 text-xs text-gray-600">
              No details available
            </p>
          )}
        </div>
      )}
    </div>
  );
}
