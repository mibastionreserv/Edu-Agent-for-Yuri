# Interactive AI Learning Platform — with the *Practical Scrum* course

A browser-based learning platform where a friendly virtual coach, **Mira**,
narrates each lesson, **draws every concept live on an interactive whiteboard**,
and answers your questions in real time — grounded strictly in the course
material. The first course, **Practical Scrum** (aligned to the Scrum Guide
2020), is already loaded.

Built to the SRS *Interactive AI Learning Platform* spec and the *Practical
Scrum* course specification, using the SRS's recommended **open-source** stack.

## What's included
- **5 modules**, taught end to end: Roles → Events → Metrics → Artifacts →
  Capstone (empiricism, values & anti-patterns), each with narration, a live
  whiteboard, grounded Q&A, and an interactive knowledge check.
- **4 languages out of the box:** English, Deutsch, Italiano, Ελληνικά. Every
  narrated line, caption, whiteboard label, knowledge base and quiz exists in
  all four; switching language reloads narration, captions, the board, the
  voice, and speech recognition.
- **Live whiteboard** rendered with **rough.js** — the same hand-drawn engine
  Excalidraw is built on — driving the course's `board_commands` vocabulary
  (cards, circles, arrows, a burndown chart with axes, etc.), revealed step by
  step as Mira speaks.
- **Grounded, intelligent Q&A:** raise a hand and ask by **text or voice**;
  answers are composed from the current module's knowledge base (never
  fabricated), spoken back by default, with off-topic questions politely
  deflected. Optional OpenAI-compatible LLM enrichment is opt-in via env vars.
- **Interactive knowledge checks:** tap-to-match, multiple-choice, true/false,
  event-ordering, and the velocity-planning drag task with live validation.
- **Resizable classroom split**, captions toggle, playback controls, progress
  persistence, and guest sign-in (no account required).

## Open-source stack (per SRS §13)
| Layer | Technology |
|---|---|
| Frontend | **React + Vite**, served by **nginx** |
| Whiteboard | **rough.js** (Excalidraw's rendering engine); `board_commands` are Excalidraw-compatible |
| Avatar | Animated 2D SVG presenter (**Rive-ready**: drop a `.riv` to upgrade to a Rive state machine) |
| Speech (TTS/STT) | Browser **Web Speech API** — no API keys; pluggable to open-source neural TTS (Piper / Coqui) |
| Backend | **Node.js + Express**, JWT auth, bcrypt password hashing |
| Database | **PostgreSQL** with a SQL migration runner |
| Q&A grounding | In-process retrieval over each module's knowledge base (RAG-style, deterministic, no key) |
| Delivery | **Docker Compose** |

## Content / code separation (SRS §6)
All teaching material lives under `course-content/` and can be edited, reordered,
translated, or extended **without touching application code**:

```
course-content/
  course.config.json          # module order, languages, avatars
  ui-strings/{en,de,it,el}.json
  avatars/avatars.json
  m1-roles/  m2-events/  m3-metrics/  m4-artifacts/  m5-capstone/
    module.json
    scripts/<id>.<lang>.script.json   # narration segments + board steps + knowledge check
    knowledge/<id>.<lang>.md          # grounding source for Q&A
```

Add a language: add its code to `supportedLanguages` and provide the matching
keys/files. Reorder or remove a module: edit `moduleSequence`.

## Quick start (Docker)
From the repository root:

```bash
docker compose up --build
```

Then open **http://localhost:8080**. Pick a language and presenter, open a
module, press **Play**, and use **Raise hand** to ask a question.

Stop with `Ctrl+C`. Learner data (guest accounts, progress, question history)
persists in the `pgdata` volume; `docker compose down -v` wipes it.

## Run locally without Docker (dev)
```bash
# backend  (needs a local PostgreSQL and DATABASE_URL)
cd backend && npm install && npm start
# frontend
cd frontend && npm install && npm run dev
```

## Configuration (`.env.example` → `.env`)
| Variable | Purpose |
|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Database credentials (local defaults only) |
| `JWT_SECRET` | Signs auth tokens — **override in production** (`openssl rand -hex 32`) |
| `CONTENT_DIR` | Path to `course-content` inside the backend container |
| `WEB_PORT` | Public web port (default `8080`) |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Optional OpenAI-compatible answer enrichment (leave blank to use the built-in grounded engine) |
| `GOOGLE_TTS_CREDENTIALS` | Optional: full JSON content of a Google Cloud service-account key with Cloud Text-to-Speech access. When set, narration/Q&A audio is synthesized via Google Cloud TTS first (stable GA product, explicit per-voice gender); Gemini TTS (via `LLM_API_KEY`/`GEMINI_TTS_API_KEY`) remains the fallback if this is unset or a call fails. |

No secrets or credentials are committed; `.env` is git-ignored.

## Tests
```bash
cd backend  && npm test   # grounded Q&A (4 languages) + auth/progress/ask API flow
cd frontend && npm test   # UI helper units
```

## Notes on the avatar and voices
The shipped presenter is a clean animated 2D SVG (Mira, plus three alternates).
The render surface is **Rive-ready**: supplying a `.riv` state machine upgrades
the avatar without code changes — mirroring how the platform treats richer
avatar back-ends as pluggable. Voices use the browser's Web Speech API, which
needs no keys; naturalness depends on the OS voices installed, and the pipeline
can be pointed at an open-source neural TTS for production-grade output.
