// Server-side text-to-speech via the Gemini API's native audio output.
//
// Why this exists: the live Simli video avatar needs a real, continuous audio
// track to lip-sync to — a Simli connection with no audio at all goes idle
// and eventually blacks out. The browser's Web Speech API can't expose its
// own audio as a track (no captureStream equivalent), so for personas with a
// live Simli face we synthesize the narration ourselves instead: the
// frontend plays the returned WAV through a normal <audio> element and feeds
// that element's captureStream() to Simli — no special permissions needed,
// unlike capturing the whole tab.
//
// Reuses the same LLM_API_KEY already configured for the Gemini LLM (no new
// signup/env var required). If the TTS call fails for any reason — model not
// enabled for this account, quota, network — the caller falls back to the
// browser's Web Speech API, so narration itself never breaks.

import { createHash } from 'node:crypto';
import { synthesizeSpeechGoogleCloud } from './googleCloudTts.js';

// Lesson narration is FIXED content: the same paragraphs are synthesized
// over and over, for every learner and every replay. Caching by
// hash(provider + text + voice + model) collapses that to one upstream call
// per distinct line, ever - the single biggest lever against the 429 quota
// errors that took TTS down.
//
// `provider` is part of the hash (not just model) so the Google Cloud TTS
// and Gemini caches never collide/overwrite each other, even for identical
// text: they return different binary formats and different voices.
//
// Stored in Postgres, NOT on local disk: Render's instance filesystem is
// ephemeral, so a disk cache is wiped on every redeploy and restart and
// would keep re-spending quota on exactly the lines it exists to protect.
// A small in-memory LRU sits in front of it for the hot path.
const memCache = new Map();
const MEM_MAX = 120;

function cacheKey(provider, text, voice, model) {
  return createHash('sha256').update(`${provider} ${model} ${voice} ${text}`).digest('hex');
}

function memPut(key, buf) {
  memCache.set(key, buf);
  if (memCache.size > MEM_MAX) memCache.delete(memCache.keys().next().value);
}

async function cacheGet(pool, key) {
  const hit = memCache.get(key);
  if (hit) {
    memCache.delete(key); memCache.set(key, hit); // refresh LRU position
    return hit;
  }
  if (!pool) return null;
  try {
    const { rows } = await pool.query('SELECT audio FROM tts_cache WHERE key = $1', [key]);
    if (!rows.length) return null;
    const buf = rows[0].audio;
    memPut(key, buf);
    // Fire-and-forget: recency only matters for optional eviction later.
    pool.query('UPDATE tts_cache SET last_used_at = now() WHERE key = $1', [key]).catch(() => {});
    return buf;
  } catch { return null; }
}

async function cacheSet(pool, key, buf) {
  memPut(key, buf);
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO tts_cache (key, audio, bytes) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET last_used_at = now()`,
      [key, buf, buf.length],
    );
  } catch { /* cache is an optimization; failing to persist is not fatal */ }
}

function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitDepth = 16 } = {}) {
  const blockAlign = channels * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Returns a WAV Buffer, or throws. Callers should catch and fall back.
//
// `languageCode`/`gender` are optional and only drive the Google Cloud TTS
// attempt below — old callers that don't pass them (or a fresh deploy before
// GOOGLE_TTS_CREDENTIALS is set on Render) skip straight to the Gemini path,
// so behavior is unchanged until both the code AND the credentials are in
// place.
export async function synthesizeSpeech(text, {
  voice = 'Gacrux', pool = null, languageCode = null, gender = null,
} = {}) {
  // Google Cloud TTS first: a mature GA product with a real gender parameter
  // and a generous free quota, unlike the preview Gemini model below. Only
  // attempted when the caller supplies both languageCode and gender (the
  // frontend does, once updated) — any failure (not configured, no voice for
  // this language+gender, network, timeout) falls through to the existing
  // Gemini path untouched.
  if (languageCode && gender) {
    const googleVoiceKey = `${languageCode}:${String(gender).toUpperCase()}`;
    const googleKey = cacheKey('google', text, googleVoiceKey, 'google-cloud-tts');
    const cachedGoogle = await cacheGet(pool, googleKey);
    if (cachedGoogle) return cachedGoogle;
    try {
      const wav = await synthesizeSpeechGoogleCloud(text, { languageCode, gender, pool });
      await cacheSet(pool, googleKey, wav);
      return wav;
    } catch (err) {
      console.error('[tts] Google Cloud TTS failed, falling back to Gemini:', err.message);
    }
  }

  return synthesizeSpeechGemini(text, { voice, pool });
}

// Uses the legacy generateContent API surface (v1beta/models/{model}:generateContent),
// not the newer Interactions API — this is the older, more established surface and
// its request/response shape is exactly what's documented at
// https://ai.google.dev/gemini-api/docs/generate-content/speech-generation.
// (An earlier version of this file called the Interactions API's /v1beta/interactions
// endpoint with a guessed request body; that shape was never confirmed against the
// real docs and is the most likely reason every call was failing.)
async function synthesizeSpeechGemini(text, { voice = 'Gacrux', pool = null } = {}) {
  const apiKey = process.env.GEMINI_TTS_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('TTS is not configured.');
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';

  // Serve from cache before spending any quota.
  const key = cacheKey('gemini', text, voice, model);
  const cached = await cacheGet(pool, key);
  if (cached) return cached;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  // Single budget for the WHOLE call (all retries combined), not per
  // attempt: the frontend gives up on this request at 30s (frontend/src/
  // api.js TTS_TIMEOUT_MS), so the server must stop retrying with margin to
  // spare — 3 uncapped 15s attempts could otherwise run past that deadline,
  // burning quota on a try nobody is waiting for anymore.
  const deadline = Date.now() + 25000;

  // Without a timeout a hung upstream call left every caller (the TTS
  // request, and transitively the classroom UI waiting on it) stuck forever
  // — see SS-6. AbortSignal.timeout() rejects with a DOMException named
  // 'TimeoutError', which the retry loop below already treats as a
  // network-level failure (retryable, same as any other fetch rejection).
  const call = () => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: text.slice(0, 4000) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
    signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
  });

  // Gemini TTS fails randomly at a low rate (documented: occasional 500s
  // when it emits text tokens instead of audio; plus 429s under load; plus
  // an HTTP 200 whose parts carry text instead of (or in addition to) audio
  // — see the parts scan below). A failed line is expensive for us: the
  // client falls back to the browser's Web Speech voice, which the live
  // avatar cannot lip-sync to — the learner sees a frozen mouth. So retry up
  // to 3 times with a short backoff on any retryable failure (5xx, 429,
  // network error, 200-without-audio) before giving up, as long as the
  // overall deadline above allows it.
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  let res = null;
  let lastErr = null;
  let b64 = null;
  let noAudioInfo = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (Date.now() >= deadline) { lastErr = new Error('TTS budget exhausted'); break; }
    if (attempt > 0) await sleep(attempt === 1 ? 300 : 900);
    if (Date.now() >= deadline) { lastErr = new Error('TTS budget exhausted'); break; }
    try {
      res = await call();
    } catch (e) {
      lastErr = e; // network-level failure — retry
      res = null;
      continue;
    }
    if (res.ok) {
      // Find the audio part anywhere in the response, not just parts[0]:
      // Gemini sometimes returns a text part alongside (or instead of, or
      // before) the audio part while still answering 200.
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const audioPart = parts.find((p) => p?.inlineData?.data);
      b64 = audioPart?.inlineData?.data || null;
      if (b64) break;
      // "200 with no audio" is retryable, same as a 5xx — Gemini's flake
      // rate for this is low but nonzero, and a second attempt usually
      // returns proper audio.
      noAudioInfo = `finishReason=${data?.candidates?.[0]?.finishReason} `
        + `partTypes=${parts.map((p) => Object.keys(p || {}).join('/')).join(',')}`;
      console.error(`[tts] 200 without audio, retrying: model=${model} ${noAudioInfo}`);
      lastErr = new Error('TTS returned no audio.');
      continue;
    }
    // 429 = quota/rate limit. Retrying makes it strictly WORSE: each attempt
    // burns another unit of the very quota we just ran out of. Fail fast and
    // let the caller latch onto the fallback voice for the session.
    if (res.status === 429) break;
    if (res.status >= 500) continue; // transient server-side flake — retry
    break; // other 4xx are config errors; retrying won't help
  }
  if (!b64) {
    if (res && !res.ok) {
      const status = res.status;
      const body = await res.text().catch(() => '');
      console.error(`[tts] request failed after retries: ${status} model=${model} body=${String(body).slice(0, 300)}`);
      throw new Error(`TTS ${status}`);
    }
    if (lastErr && lastErr.message === 'TTS returned no audio.') {
      throw new Error(`TTS returned no audio. (${noAudioInfo})`);
    }
    const detail = lastErr && lastErr.message;
    console.error(`[tts] request failed after retries: network (${detail})`);
    throw new Error(`TTS network (${detail})`);
  }
  const wav = pcmToWav(Buffer.from(b64, 'base64'));
  await cacheSet(pool, key, wav); // next request for this line costs no quota
  return wav;
}
