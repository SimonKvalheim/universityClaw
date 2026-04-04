'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface JobSummary {
  id: string;
  filename: string;
  status: string;
  error: string | null;
  retryAfter: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export function useIngestionJobs(pollInterval = 3000) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchJobs = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const res = await fetch('/api/ingestion/jobs');
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs);
      }
    } catch {
      // Network error — keep previous state
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchJobs();
    timerRef.current = setInterval(() => void fetchJobs(), pollInterval);

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) void fetchJobs();
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
  }, [fetchJobs, pollInterval]);

  const retry = useCallback(
    async (jobId: string) => {
      const res = await fetch(`/api/ingestion/retry/${jobId}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Retry failed');
      }
      // Immediate re-poll
      await fetchJobs();
    },
    [fetchJobs],
  );

  const dismiss = useCallback(
    async (jobId: string) => {
      const res = await fetch(`/api/ingestion/dismiss/${jobId}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Dismiss failed');
      }
      await fetchJobs();
    },
    [fetchJobs],
  );

  return { jobs, isLoading, retry, dismiss };
}
