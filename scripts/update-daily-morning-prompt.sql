-- One-shot shim for installs where study-daily-morning already exists.
-- Fresh installs pick up the new prompt from src/study/scheduled.ts directly.
-- Idempotent: only updates if the new instruction is not already present.
UPDATE scheduled_tasks
SET prompt = prompt || X'0A0A' || 'Before calling mcp__nanoclaw__send_voice, call mcp__nanoclaw__record_concept_delivery with the vault path of the concept you have chosen (e.g. concepts/shadow-ai-economy.md) and the surface argument set to ''text+voice''. Record-then-send is intentional: recording first means the ledger stays accurate even if a send transiently fails, so tomorrow''s run still avoids today''s concept.'
WHERE id = 'study-daily-morning'
  AND prompt NOT LIKE '%record_concept_delivery%';
