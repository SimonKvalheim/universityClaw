-- Data migration: existing 'oversized' jobs transition to 'libraried' under
-- the new pipeline. Idempotent — affects only rows currently at 'oversized'.
UPDATE ingestion_jobs
SET status = 'libraried',
    error = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'oversized';
