'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { JobSummary } from './useIngestionJobs';

export interface StagedFile {
  name: string;
  file: File;
  status: 'staged' | 'uploading' | 'uploaded' | 'upload-failed' | 'duplicate';
  error?: string;
}

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export function useFileUpload(jobs: JobSummary[]) {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  // Track uploaded server filenames (with random suffix) for duplicate detection
  const uploadedNamesRef = useRef<Map<string, number>>(new Map());

  // Check if uploaded files appeared as jobs (duplicate detection)
  useEffect(() => {
    if (uploadedNamesRef.current.size === 0) return;

    const now = Date.now();
    const updated = new Map(uploadedNamesRef.current);
    const toMarkDuplicate: string[] = [];

    for (const [serverFilename, timestamp] of updated) {
      // Check if a job with a matching filename appeared
      const found = jobs.some((j) => j.filename === serverFilename);
      if (found) {
        updated.delete(serverFilename);
      } else if (now - timestamp > 15_000) {
        toMarkDuplicate.push(serverFilename);
        updated.delete(serverFilename);
      }
    }

    uploadedNamesRef.current = updated;

    if (toMarkDuplicate.length > 0) {
      setFiles((prev) => {
        const result = prev.map((f) =>
          f.status === 'uploaded'
            ? { ...f, status: 'duplicate' as const, error: 'Already processed — duplicate content' }
            : f,
        );
        // Auto-clear duplicates after 5 seconds
        setTimeout(() => {
          setFiles((p) => p.filter((ff) => ff.status !== 'duplicate'));
        }, 5000);
        return result;
      });
    }
  }, [jobs]);

  const addFiles = useCallback((newFiles: File[]) => {
    const staged: StagedFile[] = [];
    for (const file of newFiles) {
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        staged.push({ name: file.name, file, status: 'staged', error: 'Only PDF files are supported' });
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        staged.push({ name: file.name, file, status: 'staged', error: 'File exceeds 100 MB limit' });
        continue;
      }
      staged.push({ name: file.name, file, status: 'staged' });
    }
    setFiles((prev) => [...prev, ...staged]);
  }, []);

  const removeFile = useCallback((name: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  }, []);

  const uploadAll = useCallback(async () => {
    const valid = files.filter((f) => f.status === 'staged' && !f.error);
    if (valid.length === 0) return;

    setIsUploading(true);
    setFiles((prev) =>
      prev.map((f) =>
        f.status === 'staged' && !f.error ? { ...f, status: 'uploading' as const } : f,
      ),
    );

    try {
      const formData = new FormData();
      for (const f of valid) {
        formData.append('file', f.file);
      }

      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();

      if (data.results) {
        // Track uploaded filenames for duplicate detection
        const now = Date.now();
        for (const r of data.results as Array<{ ok: boolean; filename: string }>) {
          if (r.ok && r.filename) {
            uploadedNamesRef.current.set(r.filename, now);
          }
        }

        setFiles((prev) =>
          prev.map((f) => {
            if (f.status !== 'uploading') return f;
            // Find matching result by original name prefix
            const sanitizedBase = f.name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.pdf$/i, '');
            const matchingResult = (data.results as Array<{ ok: boolean; filename: string; error?: string }>).find(
              (r) => r.ok && r.filename.startsWith(sanitizedBase),
            );
            if (matchingResult) {
              return { ...f, status: 'uploaded' as const };
            }
            const failedResult = (data.results as Array<{ ok: boolean; filename: string; error?: string }>).find(
              (r) => !r.ok && r.filename === f.name,
            );
            if (failedResult) {
              return { ...f, status: 'upload-failed' as const, error: failedResult.error };
            }
            return { ...f, status: 'uploaded' as const };
          }),
        );

        // Clear uploaded files after a short delay
        setTimeout(() => {
          setFiles((prev) => prev.filter((f) => f.status !== 'uploaded'));
        }, 3000);
      }
    } catch (err) {
      setFiles((prev) =>
        prev.map((f) =>
          f.status === 'uploading'
            ? { ...f, status: 'upload-failed' as const, error: String(err) }
            : f,
        ),
      );
    } finally {
      setIsUploading(false);
    }
  }, [files]);

  return { files, addFiles, removeFile, uploadAll, isUploading };
}
