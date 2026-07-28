import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  validateCredentials, hashPassword, verifyPassword, issueToken, requireAuth,
} from './auth.js';
import {
  loadCourse, loadModule, loadUiStrings, loadConfig, contentDir,
} from './content.js';
import { getAnswer } from './answerProvider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// createApp(pool) -> configured express app. Pool is injected so tests can pass
// an in-memory database.
export function createApp(pool) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // --- health ---
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

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
      moduleId, lang, question, history, askedByVoice,
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
      question, lang: mod.language, module: mod, history: safeHistory,
    });

    try {
      await pool.query(
        'INSERT INTO questions (user_id, module_id, lang, question, answer, topicality) VALUES ($1,$2,$3,$4,$5,$6)',
        [req.user.id, moduleId, mod.language, question.trim(), result.answer, result.topicality],
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
    const faceId = (req.body && req.body.faceId) || process.env.SIMLI_FACE_ID;
    if (!apiKey || !faceId) return res.status(503).json({ error: 'Live avatar is not configured.' });
    try {
      const simliRes = await fetch('https://api.simli.ai/compose/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-simli-api-key': apiKey },
        body: JSON.stringify({
          faceId,
          apiVersion: 'v2',
          audioInputFormat: 'pcm16',
          maxSessionLength: 600,
          maxIdleTime: 60,
          // The client feeds Simli a live MediaStreamTrack (mic or TTS output)
          // rather than discrete pre-buffered chunks, so silence handling is
          // disabled per Simli's guidance for listenToMediastreamTrack().
          handleSilence: false,
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
