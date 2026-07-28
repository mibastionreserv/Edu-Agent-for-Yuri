-- 001_init.sql
-- Schema only. No application/demo data is inserted here.
-- All users, progress, and questions are created at runtime through the API.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS progress (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  course_id     TEXT NOT NULL,
  module_id     TEXT,
  segment_index INTEGER NOT NULL DEFAULT 0,
  lang          TEXT NOT NULL DEFAULT 'en',
  avatar_id     TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id   TEXT NOT NULL,
  lang        TEXT NOT NULL,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  topicality  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
