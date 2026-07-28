-- 002_seed_test_user.sql
-- Intentionally a no-op.
-- Per the SRS acceptance checklist, a fresh database must contain schema and
-- migration metadata only: no preloaded application data and no committed
-- credentials. Learner accounts are created at runtime (guest session or the
-- register endpoint) through the API. This harmless statement keeps the
-- migration recorded in the _migrations table without inserting any data.
SELECT 1;
