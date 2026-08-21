// Google Cloud Text-to-Speech: the primary TTS provider (see tts.js, which
// tries this first and falls back to the existing Gemini TTS path on any
// failure). A GA product with a real gender parameter and a generous free
// quota, unlike the gemini-2.5-flash-preview-tts model tts.js was built
// around — that preview model's tight quota is what caused the recurring
// 429/no-audio TTS outages (SS-11/13/20/34).
//
// Google Cloud TTS only supports OAuth2 (service-account JWT-bearer flow),
// not a plain API key. The backend already depends on `jsonwebtoken` (used
// for user auth in auth.js), so we sign the assertion ourselves instead of
// pulling in google-auth-library for this one flow.

import jwt from 'jsonwebtoken';

const TOKEN_URL_DEFAULT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const VOICES_URL = 'https://texttospeech.googleapis.com/v1/voices';
const SYNTHESIZE_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// Refresh 5 minutes ahead of actual expiry so an in-flight synth call never
// straddles the token going stale mid-request.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cachedToken = null; // { accessToken, expiresAt } — module-level, one per process

// Resolved voice names are cached for the lifetime of the process, keyed by
// `${languageCode}:${gender}`, so a persona's voice stays stable across
// calls instead of possibly re-resolving to a different voice each time
// (persona voice consistency — see SS-1/SS-34 history).
const voiceCache = new Map();

function loadCredentials() {
  const raw = process.env.GOOGLE_TTS_CREDENTIALS;
  if (!raw) throw new Error('Google Cloud TTS is not configured.');
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error('Google Cloud TTS is not configured.');
  }
  if (!creds || !creds.client_email || !creds.private_key) {
    throw new Error('Google Cloud TTS is not configured.');
  }
  return creds;
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cachedToken.accessToken;
  }
  const creds = loadCredentials();
  const tokenUri = creds.token_uri || TOKEN_URL_DEFAULT;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: creds.client_email,
    scope: SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }, creds.private_key, { algorithm: 'RS256' });

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  let res;
  try {
    res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`Google Cloud TTS token request failed: ${e.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google Cloud TTS token request failed: ${res.status} ${String(text).slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Google Cloud TTS token response had no access_token.');
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return cachedToken.accessToken;
}

// Studio > Neural2 > Wavenet > Standard, judged from the voice name itself
// (e.g. "en-US-Studio-O", "de-DE-Neural2-B") — Google does not expose voice
// quality as a separate field.
const QUALITY_TIERS = ['Studio', 'Neural2', 'Wavenet', 'Standard'];

function qualityRank(voiceName) {
  const rank = QUALITY_TIERS.findIndex((tier) => voiceName.includes(tier));
  return rank === -1 ? QUALITY_TIERS.length : rank;
}

// Returns a voice name (e.g. "en-US-Studio-O") for the given BCP-47
// languageCode + SSML gender ('MALE' | 'FEMALE'), or null if none exists —
// callers must treat null as "fall back to Gemini", not throw. Deterministic
// across calls (and across server restarts, given the same voices.list
// response) and cached per language+gender for process lifetime.
export async function resolveVoiceName(languageCode, ssmlGender) {
  const gender = String(ssmlGender || '').toUpperCase();
  const key = `${languageCode}:${gender}`;
  if (voiceCache.has(key)) return voiceCache.get(key);

  const token = await getAccessToken();
  const url = `${VOICES_URL}?languageCode=${encodeURIComponent(languageCode)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google Cloud TTS voices.list failed: ${res.status} ${String(text).slice(0, 200)}`);
  }
  const data = await res.json();
  const voices = Array.isArray(data.voices) ? data.voices : [];
  const matches = voices.filter((v) => v
    && v.ssmlGender === gender
    && Array.isArray(v.languageCodes)
    && v.languageCodes.includes(languageCode));

  let chosen = null;
  if (matches.length) {
    const sorted = [...matches].sort((a, b) => (
      qualityRank(a.name) - qualityRank(b.name) || a.name.localeCompare(b.name)
    ));
    chosen = sorted[0].name;
  }
  voiceCache.set(key, chosen);
  return chosen;
}

// Returns a WAV Buffer (LINEAR16 audioConfig already includes the WAV
// header per Google's docs, so — unlike the Gemini path in tts.js, which
// gets raw PCM and wraps it itself — this is returned as-is, no
// re-wrapping), or throws. Callers (tts.js) should catch and fall back to
// Gemini.
// `pool` is accepted (not used here) only for call-signature parity with the
// Gemini path in tts.js — caching itself lives entirely in tts.js.
export async function synthesizeSpeechGoogleCloud(text, { languageCode, gender } = {}) {
  if (!languageCode || !gender) {
    throw new Error('Google Cloud TTS requires languageCode and gender.');
  }
  const ssmlGender = String(gender).toUpperCase();
  const token = await getAccessToken();
  const voiceName = await resolveVoiceName(languageCode, ssmlGender);
  if (!voiceName) {
    throw new Error(`Google Cloud TTS has no voice for ${languageCode}/${ssmlGender}.`);
  }

  const res = await fetch(SYNTHESIZE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: voiceName, ssmlGender },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text2 = await res.text().catch(() => '');
    throw new Error(`Google Cloud TTS synthesize failed: ${res.status} ${String(text2).slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.audioContent) throw new Error('Google Cloud TTS returned no audioContent.');
  return Buffer.from(data.audioContent, 'base64');
}

// Test-only: lets tests reset module-level caches between runs.
export function _resetForTests() {
  cachedToken = null;
  voiceCache.clear();
}
