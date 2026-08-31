import { generateKeyPairSync } from 'node:crypto';
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

const {
  resolveVoiceName, synthesizeSpeechGoogleCloud, _resetForTests,
} = await import('../src/googleCloudTts.js');

// A syntactically valid RSA key is enough for jwt.sign(..., {algorithm:
// 'RS256'}) to succeed — Google never actually verifies this signature in
// these tests, only our own mocked fetch does.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const FAKE_CREDENTIALS = JSON.stringify({
  client_email: 'test-tts@example.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: 'https://oauth2.googleapis.com/token',
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() { return this; },
  };
}

function tokenResponse(accessToken = 'fake-access-token', expiresIn = 3600) {
  return jsonResponse({ access_token: accessToken, expires_in: expiresIn });
}

function voicesResponse(voices) {
  return jsonResponse({ voices });
}

const EN_VOICES = [
  {
    name: 'en-US-Standard-C', ssmlGender: 'FEMALE', languageCodes: ['en-US'], naturalSampleRateHertz: 24000,
  },
  {
    name: 'en-US-Wavenet-D', ssmlGender: 'MALE', languageCodes: ['en-US'], naturalSampleRateHertz: 24000,
  },
  {
    name: 'en-US-Studio-O', ssmlGender: 'FEMALE', languageCodes: ['en-US'], naturalSampleRateHertz: 24000,
  },
  {
    name: 'en-US-Neural2-A', ssmlGender: 'MALE', languageCodes: ['en-US'], naturalSampleRateHertz: 24000,
  },
];

// Routes a mocked fetch call to a handler keyed by a substring of the URL —
// lets each test describe token/voices/synthesize behavior independently of
// call order.
function routedFetch(routes) {
  return vi.fn((url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) throw new Error(`unexpected fetch to ${url}`);
    return routes[key]();
  });
}

describe('googleCloudTts', () => {
  let originalFetch;
  let originalEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = process.env.GOOGLE_TTS_CREDENTIALS;
    _resetForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.GOOGLE_TTS_CREDENTIALS = originalEnv;
    vi.restoreAllMocks();
  });

  it('throws a clear "not configured" error, not a crash, when GOOGLE_TTS_CREDENTIALS is unset', async () => {
    delete process.env.GOOGLE_TTS_CREDENTIALS;
    global.fetch = vi.fn(); // must never be called
    await expect(resolveVoiceName('en-US', 'MALE')).rejects.toThrow(/not configured/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws a clear "not configured" error when GOOGLE_TTS_CREDENTIALS is not valid JSON', async () => {
    process.env.GOOGLE_TTS_CREDENTIALS = '{not json';
    global.fetch = vi.fn();
    await expect(resolveVoiceName('en-US', 'MALE')).rejects.toThrow(/not configured/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches and caches an OAuth2 access token: a second resolveVoiceName call (different lang) does not request a new token', async () => {
    process.env.GOOGLE_TTS_CREDENTIALS = FAKE_CREDENTIALS;
    const tokenFetch = vi.fn(() => tokenResponse());
    const voicesFetch = vi.fn(() => voicesResponse(EN_VOICES));
    global.fetch = routedFetch({
      'oauth2.googleapis.com/token': tokenFetch,
      '/v1/voices': voicesFetch,
    });

    await resolveVoiceName('en-US', 'MALE');
    await resolveVoiceName('de-DE', 'FEMALE'); // different cache key — voices IS refetched…

    expect(tokenFetch).toHaveBeenCalledTimes(1); // …but the token is reused, not refetched
    expect(voicesFetch).toHaveBeenCalledTimes(2);
  });

  it('filters voices.list by ssmlGender and languageCodes, preferring higher quality tiers (Studio > Neural2 > Wavenet > Standard)', async () => {
    process.env.GOOGLE_TTS_CREDENTIALS = FAKE_CREDENTIALS;
    global.fetch = routedFetch({
      'oauth2.googleapis.com/token': () => tokenResponse(),
      '/v1/voices': () => voicesResponse(EN_VOICES),
    });

    const female = await resolveVoiceName('en-US', 'FEMALE');
    const male = await resolveVoiceName('en-US', 'MALE');

    // Studio-O beats Standard-C for FEMALE; Neural2-A beats Wavenet-D for MALE.
    expect(female).toBe('en-US-Studio-O');
    expect(male).toBe('en-US-Neural2-A');
  });

  it('returns null (not a throw) when no voice matches the language+gender, so the caller can fall back to Gemini', async () => {
    process.env.GOOGLE_TTS_CREDENTIALS = FAKE_CREDENTIALS;
    global.fetch = routedFetch({
      'oauth2.googleapis.com/token': () => tokenResponse(),
      '/v1/voices': () => voicesResponse(EN_VOICES), // no MALE voice for fr-FR at all
    });

    const voice = await resolveVoiceName('fr-FR', 'MALE');
    expect(voice).toBeNull();
  });

  it('resolves the SAME voice name on repeated calls for the same language+gender (persona voice consistency, SS-1/SS-34)', async () => {
    process.env.GOOGLE_TTS_CREDENTIALS = FAKE_CREDENTIALS;
    const voicesFetch = vi.fn(() => voicesResponse(EN_VOICES));
    global.fetch = routedFetch({
      'oauth2.googleapis.com/token': () => tokenResponse(),
      '/v1/voices': voicesFetch,
    });

    const first = await resolveVoiceName('en-US', 'MALE');
    const second = await resolveVoiceName('en-US', 'MALE');

    expect(first).toBe(second);
    expect(voicesFetch).toHaveBeenCalledTimes(1); // resolved once, then served from cache
  });

  it('synthesizes speech end-to-end: resolves a voice, calls text:synthesize, and returns the decoded audio Buffer as-is (no re-wrapping)', async () => {
    process.env.GOOGLE_TTS_CREDENTIALS = FAKE_CREDENTIALS;
    const audioBytes = Buffer.from('RIFFfake-wav-body');
    global.fetch = routedFetch({
      'oauth2.googleapis.com/token': () => tokenResponse(),
      '/v1/voices': () => voicesResponse(EN_VOICES),
      'text:synthesize': () => jsonResponse({ audioContent: audioBytes.toString('base64') }),
    });

    const buf = await synthesizeSpeechGoogleCloud('hello there', { languageCode: 'en-US', gender: 'MALE' });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(audioBytes)).toBe(true);
  });

  it('throws a clear error when no voice exists for the requested language+gender', async () => {
    process.env.GOOGLE_TTS_CREDENTIALS = FAKE_CREDENTIALS;
    global.fetch = routedFetch({
      'oauth2.googleapis.com/token': () => tokenResponse(),
      '/v1/voices': () => voicesResponse(EN_VOICES),
    });

    await expect(synthesizeSpeechGoogleCloud('hello', { languageCode: 'fr-FR', gender: 'MALE' }))
      .rejects.toThrow(/no voice/i);
  });
});
