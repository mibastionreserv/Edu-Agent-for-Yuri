import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  validateCredentials, hashPassword, verifyPassword, issueToken, requireAuth,
} from './auth.js';
import {
  loadCourse, loadModule, loadUiStrings, loadConfig, contentDir,
} from './content.js';
import { getAnswer } from './answerProvider.js';
import { synthesizeSpeech } from './tts.js';
import { createConversation, endConversation } from './tavus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dockerfile.render stamps this file with the image build time (SS-32); it
// doesn't exist outside the container (local dev, tests), hence the try/catch.
function readBuildTime() {
  try {
    return readFileSync(join(__dirname, '..', 'BUILD_TIME'), 'utf8').trim();
  } catch {
    return process.env.BUILD_TIME || 'unknown';
  }
}

const builtAt = readBuildTime();

// createApp(pool) -> configured express app. Pool is injected so tests can pass
// an in-memory database.
export function createApp(pool) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // --- health ---
  // commit/builtAt let deploy tooling confirm a fresh Docker image actually
  // landed on Render (SS-32), without needing server log access.
  app.get('/api/health', (_req, res) => res.json({
    status: 'ok',
    commit: process.env.RENDER_GIT_COMMIT || 'unknown',
    builtAt,
  }));

  // --- static course assets (public course material, read-only) ---
  app.use('/content', express.static(contentDir(), { fallthrough: true }));

  // --- localized UI strings + avatars ---
  app.get('/api/ui-strings', (req, res) => {
    try {
      res.json(loadUiStrings(String(req.query.lang || 'en')));
    } catch {
      res.status(500).json({ error: 'Could not load UI strings.' });
    }
  });

  // --- course + modules ---
  app.get('/api/course', (req, res) => {
    try {
      res.json(loadCourse(String(req.query.lang || 'en')));
    } catch {
      res.status(500).json({ error: 'Could not load the course.' });
    }
  });

  app.get('/api/modules/:id', (req, res) => {
    try {
      const mod = loadModule(req.params.id, String(req.query.lang || 'en'));
      if (!mod) return res.status(404).json({ error: 'Module not found.' });
      return res.json(mod);
    } catch {
      return res.status(500).json({ error: 'Could not load the module.' });
    }
  });

  // --- auth: register ---
  app.post('/api/auth/register', async (req, res) => {
    const { email, password, displayName } = req.body || {};
    const errors = validateCredentials({ email, password });
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    try {
      const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase()]);
      if (exists.rows.length) return res.status(409).json({ error: 'That email is already registered.' });
      const hash = await hashPassword(password);
      const { rows } = await pool.query(
        'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name',
        [email.toLowerCase(), hash, displayName || null],
      );
      const user = rows[0];
      return res.status(201).json({ token: issueToken(user), user: { id: user.id, email: user.email, displayName: user.display_name } });
    } catch {
      return res.status(500).json({ error: 'Could not create the account.' });
    }
  });

  // --- auth: login ---
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    try {
      const { rows } = await pool.query('SELECT id, email, password_hash, display_name FROM users WHERE email = $1', [String(email).toLowerCase()]);
      const user = rows[0];
      const ok = user && (await verifyPassword(password, user.password_hash));
      if (!ok) return res.status(401).json({ error: 'Email or password is incorrect.' });
      return res.json({ token: issueToken(user), user: { id: user.id, email: user.email, displayName: user.display_name } });
    } catch {
      return res.status(500).json({ error: 'Could not sign in.' });
    }
  });

  // --- auth: guest (no registration, no password) ---
  // Creates a fresh anonymous account and returns a token. The frontend calls
  // this automatically on first load, so learners never see a login form.
  app.post('/api/auth/guest', async (_req, res) => {
    try {
      const rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const email = `guest-${rand}@scrumstage.local`;
      const { rows } = await pool.query(
        'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name',
        [email, 'guest-no-password-login', 'Guest'],
      );
      const user = rows[0];
      return res.status(201).json({ token: issueToken(user), user: { id: user.id, email: user.email, displayName: user.display_name } });
    } catch {
      return res.status(500).json({ error: 'Could not start a guest session.' });
    }
  });

  // --- progress (persisted, per user) ---
  app.get('/api/progress', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT course_id, module_id, segment_index, lang, avatar_id FROM progress WHERE user_id = $1', [req.user.id]);
      return res.json(rows[0] || null);
    } catch {
      return res.status(500).json({ error: 'Could not load progress.' });
    }
  });

  app.put('/api/progress', requireAuth, async (req, res) => {
    const { courseId, moduleId, segmentIndex, lang, avatarId } = req.body || {};
    if (!courseId) return res.status(400).json({ error: 'courseId is required.' });
    const seg = Number.isInteger(segmentIndex) ? segmentIndex : 0;
    try {
      const existing = await pool.query('SELECT id FROM progress WHERE user_id = $1', [req.user.id]);
      if (existing.rows.length) {
        await pool.query(
          'UPDATE progress SET course_id=$2, module_id=$3, segment_index=$4, lang=$5, avatar_id=$6, updated_at=now() WHERE user_id=$1',
          [req.user.id, courseId, moduleId || null, seg, lang || 'en', avatarId || null],
        );
      } else {
        await pool.query(
          'INSERT INTO progress (user_id, course_id, module_id, segment_index, lang, avatar_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [req.user.id, courseId, moduleId || null, seg, lang || 'en', avatarId || null],
        );
      }
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not save progress.' });
    }
  });

  // --- ask a question (grounded, intelligent; voice-aware for the client) ---
  app.post('/api/ask', requireAuth, async (req, res) => {
    const {
      moduleId, lang, question, history, askedByVoice, avatarId,
    } = req.body || {};
    if (!moduleId || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'moduleId and a question are required.' });
    }
    if (question.length > 1000) return res.status(400).json({ error: 'Question is too long.' });
    let mod;
    try {
      mod = loadModule(moduleId, String(lang || 'en'));
    } catch {
      mod = null;
    }
    if (!mod) return res.status(404).json({ error: 'Module not found.' });

    const safeHistory = Array.isArray(history)
      ? history.filter((h) => h && typeof h.text === 'string').slice(-6)
      : [];

    const result = await getAnswer({
      question, lang: mod.language, module: mod, history: safeHistory, avatarId,
    });

    try {
      await pool.query(
        'INSERT INTO questions (user_id, module_id, lang, question, answer, topicality, provider, confidence, certainty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [req.user.id, moduleId, mod.language, question.trim(), result.answer, result.topicality, result.provider || null, result.confidence ?? null, result.certainty || null],
      );
    } catch {
      // Logging failure should not break the learner's flow.
    }
    // The client mirrors modality: a voice question should be answered by voice.
    return res.json({ ...result, speak: Boolean(askedByVoice) });
  });

  // --- Simli live avatar: mint a short-lived session token server-side so the
  // Simli API key never reaches the browser. Enabled only when SIMLI_API_KEY
  // (and a faceId) are configured; the client falls back to the static photo
  // avatar if this errors or isn't configured.
  app.post('/api/simli-token', requireAuth, async (req, res) => {
    const apiKey = process.env.SIMLI_API_KEY;
    // SIMLI_FACE_ID wins over whatever the client asks for: swapping the
    // avatar (e.g. to one created on app.simli.com) is then an env-var
    // change on Render, with no code edit or redeploy of the frontend.
    const faceId = process.env.SIMLI_FACE_ID || (req.body && req.body.faceId);
    if (!apiKey || !faceId) return res.status(503).json({ error: 'Live avatar is not configured.' });
    try {
      const simliRes = await fetch('https://api.simli.ai/compose/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-simli-api-key': apiKey },
        body: JSON.stringify({
          faceId,
          apiVersion: 'v2',
          audioInputFormat: 'pcm16',
          // The avatar is now connected for the whole lesson (pre-warmed on
          // classroom open, SRS FR-AV-5), so the session must comfortably
          // outlive a full module (~10-12 min) plus Q&A pauses. The old
          // 600s/60s limits made Simli kill the session mid-lesson — the
          // avatar froze or silently died the moment the learner paused for
          // over a minute.
          maxSessionLength: 3600,
          maxIdleTime: 900,
          // MUST be true: the avatar is connected from classroom open but no
          // audio flows until the learner presses Play (and between lines).
          // With handleSilence:false Simli renders NO frames during silence —
          // the learner saw a black rectangle instead of the avatar. With
          // true, Simli generates its own native idle animation (breathing,
          // blinking) whenever the input track is silent, and switches to
          // real lip-sync as soon as narration audio flows.
          handleSilence: true,
        }),
      });
      const data = await simliRes.json();
      if (!simliRes.ok || !data.session_token) {
        return res.status(502).json({ error: data.detail || 'Simli rejected the session request.' });
      }
      return res.json({ session_token: data.session_token });
    } catch {
      return res.status(502).json({ error: 'Could not reach Simli.' });
    }
  });

  // --- Simli ICE servers for the WebRTC P2P transport. Proxied server-side
  // for the same reason as /api/simli-token: the Simli API key never reaches
  // the browser. The returned TURN credentials are short-lived and meant to
  // be handed to clients, unlike the API key itself.
  app.get('/api/simli-ice', requireAuth, async (_req, res) => {
    const apiKey = process.env.SIMLI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Live avatar is not configured.' });
    try {
      const simliRes = await fetch('https://api.simli.ai/compose/ice', {
        headers: { 'x-simli-api-key': apiKey },
      });
      if (!simliRes.ok) return res.status(502).json({ error: 'Simli rejected the ICE request.' });
      const iceServers = await simliRes.json();
      return res.json({ iceServers });
    } catch {
      return res.status(502).json({ error: 'Could not reach Simli.' });
    }
  });

  // --- Server-side TTS: gives the live Simli avatar real audio to lip-sync
  // to (segment narration, the raise-hand prompt, Q&A answers). Tries Google
  // Cloud TTS first (when languageCode/gender are supplied and
  // GOOGLE_TTS_CREDENTIALS is configured), falling back to the Gemini key
  // already configured for LLM_API_KEY — see tts.js. Personas without a
  // Simli face keep using the browser's Web Speech API and never call this;
  // if it fails for any reason, the frontend falls back to Web Speech API
  // too, so narration itself is never at risk.
  app.post('/api/tts', requireAuth, async (req, res) => {
    const {
      text, voice, languageCode, gender,
    } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required.' });
    }
    try {
      const wav = await synthesizeSpeech(text.trim(), {
        voice: voice || undefined,
        languageCode: languageCode || undefined,
        gender: gender || undefined,
        pool,
      });
      res.set('Content-Type', 'audio/wav');
      // Narration for a given line never changes, so let the browser keep it
      // too — a re-listen or a back-and-forth between segments then costs no
      // request at all, on top of the server-side cache.
      res.set('Cache-Control', 'private, max-age=86400');
      return res.send(wav);
    } catch (err) {
      const detail = (err && err.message) || 'unknown';
      console.error(`[tts] falling back to client speech: ${detail}`);
      // Surface the upstream reason (status code / message only, never the
      // key) so a quota or model problem is diagnosable from the browser
      // instead of looking like a generic outage.
      return res.status(502).json({ error: 'TTS is unavailable.', detail });
    }
  });

  // --- Tavus live avatar (Amara): mint a conversation server-side so the
  // Tavus API key never reaches the browser. Enabled only when
  // TAVUS_API_KEY and TAVUS_PERSONA_ID are configured; the client keeps the
  // static photo avatar if this errors or isn't configured.
  app.post('/api/tavus-conversation', requireAuth, async (_req, res) => {
    try {
      const { conversationId, conversationUrl } = await createConversation({});
      return res.json({ conversationId, conversationUrl });
    } catch (err) {
      console.error(`[tavus] could not start conversation: ${err && err.message}`);
      return res.status(503).json({ error: (err && err.message) || 'Tavus is unavailable.' });
    }
  });

  // Ends a conversation early (learner left the lesson) so free-tier
  // minutes aren't burned by an idle call. Best-effort — always 200s.
  app.post('/api/tavus-conversation/:id/end', requireAuth, async (req, res) => {
    await endConversation(req.params.id);
    return res.json({ ok: true });
  });

  app.get('/api/questions', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT module_id, lang, question, answer, topicality, created_at FROM questions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
        [req.user.id],
      );
      return res.json(rows);
    } catch {
      return res.status(500).json({ error: 'Could not load questions.' });
    }
  });

  // --- serve built frontend when present (single-container option) ---
  const staticDir = join(__dirname, '..', 'public');
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/content')) return next();
      return res.sendFile(join(staticDir, 'index.html'));
    });
  }

  // config accessor for callers/tests
  app.locals.config = () => loadConfig();
  return app;
}
