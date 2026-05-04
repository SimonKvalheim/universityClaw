-- Data migration: existing 'oversized' jobs transition to 'extracted' so the
-- new librarying stage runs and writes vault/library/{slug}.md before the
-- over-budget branch in handleGeneration creates the stub source draft.
-- Transitioning straight to 'libraried' would skip librarying entirely and
-- leave the stub pointing at a non-existent library file.
-- Idempotent — affects only rows currently at 'oversized'.
UPDATE ingestion_jobs
SET status = 'extracted',
    error = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'oversized';
