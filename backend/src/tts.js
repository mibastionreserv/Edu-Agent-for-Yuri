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
// Uses the legacy generateContent API surface (v1beta/models/{model}:generateContent),
// not the newer Interactions API — this is the older, more established surface and
// its request/response shape is exactly what's documented at
// https://ai.google.dev/gemini-api/docs/generate-content/speech-generation.
// (An earlier version of this file called the Interactions API's /v1beta/interactions
// endpoint with a guessed request body; that shape was never confirmed against the
// real docs and is the most likely reason every call was failing.)
export async function synthesizeSpeech(text, { voice = 'Gacrux' } = {}) {
  const apiKey = process.env.GEMINI_TTS_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('TTS is not configured.');
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

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
  });

  // Gemini TTS fails randomly at a low rate (documented: occasional 500s
  // when it emits text tokens instead of audio; plus 429s under load).
  // A failed line is expensive for us: the client falls back to the
  // browser's Web Speech voice, which the live avatar cannot lip-sync to —
  // the learner sees a frozen mouth. So retry up to 3 times with a short
  // backoff on any retryable failure (5xx, 429, network error) before
  // giving up.
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  let res = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(attempt === 1 ? 300 : 900);
    try {
      res = await call();
    } catch (e) {
      lastErr = e; // network-level failure — retry
      res = null;
      continue;
    }
    if (res.ok) break;
    if (res.status >= 500 || res.status === 429) continue; // retryable
    break; // 4xx config errors won't get better by retrying
  }
  if (!res || !res.ok) {
    const status = res ? res.status : `network (${lastErr && lastErr.message})`;
    const body = res ? await res.text().catch(() => '') : '';
    console.error(`[tts] request failed after retries: ${status} model=${model} body=${String(body).slice(0, 300)}`);
    throw new Error(`TTS ${status}`);
  }
  const data = await res.json();
  const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error('TTS returned no audio.');
  return pcmToWav(Buffer.from(b64, 'base64'));
}
