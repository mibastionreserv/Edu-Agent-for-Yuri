import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

// Mocked so these tests exercise tts.js's fallback logic in isolation, not
// real network calls to Google — googleCloudTts.js has its own dedicated
// test suite (test/googleCloudTts.test.js).
vi.mock('../src/googleCloudTts.js', () => ({ synthesizeSpeechGoogleCloud: vi.fn() }));

process.env.LLM_API_KEY = 'test-key';

const { synthesizeSpeech } = await import('../src/tts.js');
const { synthesizeSpeechGoogleCloud } = await import('../src/googleCloudTts.js');

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() { return this; },
  };
}

const AUDIO_B64 = Buffer.from([1, 2, 3, 4]).toString('base64');

describe('synthesizeSpeech (SS-11 / SS-13)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('finds the audio part even when it is not parts[0] (SS-11)', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      candidates: [{
        content: {
          parts: [
            { text: 'a stray text part before the audio' },
            { inlineData: { mimeType: 'audio/pcm', data: AUDIO_B64 } },
          ],
        },
      }],
    }));

    const wav = await synthesizeSpeech('hello world, this line is unique enough to skip the cache', { pool: null });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // WAV = 44-byte header + PCM payload.
    expect(wav.length).toBe(44 + 4);
  });

  it('retries a 200 response with no audio part instead of failing immediately (SS-11)', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'oops, text only' }] } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: AUDIO_B64 } }] } }],
      }));

    const wav = await synthesizeSpeech('a second unique line for this test, no audio then audio', { pool: null });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(wav.length).toBe(44 + 4);
  });

  it('throws a retryable "no audio" error, not a hard failure, if every attempt is 200-without-audio (SS-11)', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'never any audio' }] } }],
    }));

    await expect(synthesizeSpeech('a third unique line, always empty of audio', { pool: null }))
      .rejects.toThrow(/no audio/i);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('stops retrying once the shared deadline is exhausted, well under the client timeout (SS-13)', async () => {
    // Simulate: deadline calc + the first attempt's two pre-flight checks
    // and its AbortSignal.timeout() calc (4 calls) all land comfortably
    // inside the 25s budget; every call after that (i.e. the second
    // attempt's pre-flight check) reports the budget as exhausted, so the
    // loop must stop instead of firing a second fetch.
    const start = Date.now();
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1;
      return calls <= 4 ? start : start + 25500;
    });

    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'still no audio' }] } }],
    }));

    await expect(synthesizeSpeech('a fourth unique line for the deadline test', { pool: null }))
      .rejects.toThrow(/budget exhausted/i);
    // Only the first attempt's fetch runs — the pre-attempt deadline check
    // ahead of the second attempt stops the loop before it fires.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('synthesizeSpeech: Google Cloud TTS as primary provider, Gemini as fallback', () => {
  let originalFetch;
  let consoleErrorSpy;

  beforeEach(() => {
    originalFetch = global.fetch;
    synthesizeSpeechGoogleCloud.mockReset();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('without languageCode/gender, behaves exactly as before — never touches the Google Cloud TTS path (safe to deploy before GOOGLE_TTS_CREDENTIALS exists)', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: AUDIO_B64 } }] } }],
    }));

    const wav = await synthesizeSpeech('an old-style call with no languageCode or gender at all', { pool: null });
    expect(synthesizeSpeechGoogleCloud).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(wav.length).toBe(44 + 4);
  });

  it('with languageCode/gender, tries Google Cloud TTS first and falls back to Gemini on any failure', async () => {
    synthesizeSpeechGoogleCloud.mockRejectedValue(new Error('Google Cloud TTS is not configured.'));
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: AUDIO_B64 } }] } }],
    }));

    const wav = await synthesizeSpeech('a line synthesized with languageCode and gender supplied', {
      pool: null, languageCode: 'en-US', gender: 'MALE',
    });

    expect(synthesizeSpeechGoogleCloud).toHaveBeenCalledTimes(1);
    expect(synthesizeSpeechGoogleCloud).toHaveBeenCalledWith(
      'a line synthesized with languageCode and gender supplied',
      expect.objectContaining({ languageCode: 'en-US', gender: 'MALE' }),
    );
    expect(global.fetch).toHaveBeenCalledTimes(1); // Gemini fallback ran
    expect(wav.length).toBe(44 + 4);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[tts] Google Cloud TTS failed, falling back to Gemini:',
      'Google Cloud TTS is not configured.',
    );
  });

  it('keeps the Gemini and Google Cloud caches separate for identical text (provider is part of cacheKey)', async () => {
    const uniqueText = 'a cache-separation test line, unique across the whole suite';

    synthesizeSpeechGoogleCloud.mockResolvedValueOnce(Buffer.from('GOOGLE-AUDIO-BYTES'));
    const googleWav = await synthesizeSpeech(uniqueText, {
      pool: null, languageCode: 'en-US', gender: 'MALE',
    });
    expect(googleWav.toString()).toBe('GOOGLE-AUDIO-BYTES');
    expect(synthesizeSpeechGoogleCloud).toHaveBeenCalledTimes(1);

    // Same text/languageCode/gender again — must be served from the cache
    // entry Google's own call wrote, not re-invoke Google Cloud TTS.
    const googleWavAgain = await synthesizeSpeech(uniqueText, {
      pool: null, languageCode: 'en-US', gender: 'MALE',
    });
    expect(googleWavAgain.toString()).toBe('GOOGLE-AUDIO-BYTES');
    expect(synthesizeSpeechGoogleCloud).toHaveBeenCalledTimes(1); // still 1 — cache hit

    // Same text, but the OLD call shape (no languageCode/gender): must go
    // straight to Gemini and must NOT be satisfied by the Google cache entry
    // above, proving the two providers' cache keys don't collide.
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: AUDIO_B64 } }] } }],
    }));
    const geminiWav = await synthesizeSpeech(uniqueText, { pool: null });
    expect(global.fetch).toHaveBeenCalledTimes(1); // Gemini really ran — no false cache hit
    expect(geminiWav.length).toBe(44 + 4); // Gemini's own WAV framing, not the raw Google bytes
  });
});
