'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface RagDocument {
  id: string;
  content_summary: string | null;
  content_length: number | null;
  status: string;
  created_at: string;
  updated_at: string;
  file_path: string | null;
  error_msg: string | null;
  chunks_count: number | null;
}

export interface RagStatus {
  health: {
    status: string;
    pipeline_busy: boolean;
    llm_binding: string;
    llm_model: string;
    embedding_binding: string;
    embedding_model: string;
  };
  counts: {
    pending: number;
    processing: number;
    preprocessed: number;
    processed: number;
    failed: number;
    all: number;
  };
  pipeline: {
    busy: boolean;
    job_name: string;
    job_start: string | null;
    docs: number;
    cur_batch: number;
    batchs: number;
    latest_message: string;
  };
  failedDocs: RagDocument[];
  processingDocs: RagDocument[];
}

const POLL_BUSY = 10_000;
const POLL_IDLE = 60_000;

export function useRagStatus() {
  const [data, setData] = useState<RagStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const res = await fetch('/api/rag-status');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      const json: RagStatus = await res.json();
      setData(json);
      setError(null);

      // Adjust poll interval when busy state changes
      const nowBusy = json.health.pipeline_busy || json.pipeline.busy;
      if (nowBusy !== busyRef.current) {
        busyRef.current = nowBusy;
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(
          () => void fetchStatus(),
          nowBusy ? POLL_BUSY : POLL_IDLE,
        );
      }
    } catch {
      // Network error — keep previous state
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    timerRef.current = setInterval(() => void fetchStatus(), POLL_BUSY);

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) void fetchStatus();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    };
  }, [fetchStatus]);

  const retryFailed = useCallback(async () => {
    const res = await fetch('/api/rag-status/retry', { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Retry failed');
    }
    await fetchStatus();
  }, [fetchStatus]);

  return { data, error, isLoading, retryFailed, refetch: fetchStatus };
}
