-- Durable cache for synthesized narration audio.
--
-- Lesson narration is fixed content, so the same paragraphs were being sent
-- to Gemini TTS again for every learner and every replay — which is what
-- exhausted the daily quota (upstream 429). Caching makes each distinct line
-- cost exactly one synthesis, ever.
--
-- This lives in Postgres rather than on disk because the app runs on Render,
-- whose instance filesystem is ephemeral: a disk cache is wiped on every
-- redeploy and restart, so it would keep re-spending quota on exactly the
-- lines it was meant to protect.
CREATE TABLE IF NOT EXISTS tts_cache (
  key         TEXT PRIMARY KEY,        -- sha256(model + voice + text)
  audio       BYTEA NOT NULL,          -- WAV bytes, ready to serve
  bytes       INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports evicting the coldest entries first if the table ever needs capping.
CREATE INDEX IF NOT EXISTS tts_cache_last_used_idx ON tts_cache (last_used_at);
