import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { pickVoice } from '../src/speech.js';

function makeVoice(name, lang) {
  return { name, lang, localService: true };
}

describe('pickVoice gender-aware fallback (SS-12)', () => {
  let originalSynthesis;

  beforeEach(() => {
    originalSynthesis = window.speechSynthesis;
  });

  afterEach(() => {
    window.speechSynthesis = originalSynthesis;
  });

  it('prefers a male-named voice for a male persona over a female-named one', async () => {
    const voices = [
      makeVoice('Microsoft Zira - English (United States)', 'en-US'),
      makeVoice('Microsoft David - English (United States)', 'en-US'),
    ];
    window.speechSynthesis = { getVoices: () => voices };

    const voice = await pickVoice('en', 'male');
    expect(voice.name).toMatch(/david/i);
  });

  it('prefers a female-named voice for a female persona over a male-named one', async () => {
    const voices = [
      makeVoice('Microsoft David - English (United States)', 'en-US'),
      makeVoice('Microsoft Zira - English (United States)', 'en-US'),
    ];
    window.speechSynthesis = { getVoices: () => voices };

    const voice = await pickVoice('en', 'female');
    expect(voice.name).toMatch(/zira/i);
  });

  it('without a gender hint, falls back to language ranking only (unchanged behavior)', async () => {
    const voices = [makeVoice('Microsoft David - English (United States)', 'en-US')];
    window.speechSynthesis = { getVoices: () => voices };

    const voice = await pickVoice('en');
    expect(voice.name).toMatch(/david/i);
  });
});
