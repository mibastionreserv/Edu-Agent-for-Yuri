-- Observability for Q&A: which provider answered, and how confident it was.
--
-- Without this, a silent LLM -> local degradation (or a wrong-entity local
-- answer) is invisible outside of a live debugging session. provider/
-- confidence/certainty are already computed per answer (see backend/src/qa.js
-- and answerProvider.js) but were never persisted, so this is schema-only:
-- no backfill for existing rows, they simply stay NULL.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS confidence REAL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS certainty TEXT;
