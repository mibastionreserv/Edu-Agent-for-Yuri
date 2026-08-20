import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

process.env.LLM_API_KEY = 'test-key';

const { synthesizeSpeech } = await import('../src/tts.js');

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
