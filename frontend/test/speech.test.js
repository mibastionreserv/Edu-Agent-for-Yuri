import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { pickVoice, pickVoiceInfo } from '../src/speech.js';

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

// SS-34: a "quality" bonus (e.g. +5 for a name matching /google/) used to be
// summed straight into the same score as the gender bonus/penalty, so it
// could outweigh a gender mismatch entirely. "Google US English" — Chrome/
// Windows' single most common default voice — has no male/female marker in
// its own name, so it scored the same regardless of the requested gender and
// both a male and a female persona fell back onto the exact same voice.
describe('pickVoice gender is a hard filter, not an additive score (SS-34)', () => {
  let originalSynthesis;

  beforeEach(() => { originalSynthesis = window.speechSynthesis; });
  afterEach(() => { window.speechSynthesis = originalSynthesis; });

  it('a realistic Chrome/Windows voice list ("Google US English" + Zira + David) resolves male and female personas to DIFFERENT voices', async () => {
    const voices = [
      makeVoice('Google US English', 'en-US'),
      makeVoice('Microsoft Zira - English (United States)', 'en-US'),
      makeVoice('Microsoft David - English (United States)', 'en-US'),
    ];
    window.speechSynthesis = { getVoices: () => voices };

    const male = await pickVoice('en', 'male');
    const female = await pickVoice('en', 'female');

    expect(male).toBeTruthy();
    expect(female).toBeTruthy();
    expect(male.name).not.toBe(female.name);
    // Specifically: "Google US English" (unlabeled, quality-bonus voice)
    // must not be handed to the male persona just because of that bonus —
    // it is classified female and a real male-named voice is available.
    expect(male.name).not.toMatch(/google us english/i);
  });

  it('a "Google UK English Male" / "Google UK English Female" pair resolves each persona to its own matching voice', async () => {
    const voices = [
      makeVoice('Google UK English Male', 'en-GB'),
      makeVoice('Google UK English Female', 'en-GB'),
    ];
    window.speechSynthesis = { getVoices: () => voices };

    const male = await pickVoice('en', 'male');
    const female = await pickVoice('en', 'female');

    expect(male.name).toMatch(/male/i);
    expect(male.name).not.toMatch(/female/i);
    expect(female.name).toMatch(/female/i);
  });

  it('when only opposite-gender voices are installed, returns null instead of speaking with the wrong voice', async () => {
    const voices = [
      makeVoice('Google US English', 'en-US'),
      makeVoice('Microsoft Zira - English (United States)', 'en-US'),
    ];
    window.speechSynthesis = { getVoices: () => voices };

    const voice = await pickVoice('en', 'male');
    expect(voice).toBeFalsy();
  });

  it('pickVoiceInfo reports "none" (not a wrong-gender voice) for the same female-only voice list', async () => {
    const voices = [makeVoice('Microsoft Zira - English (United States)', 'en-US')];
    window.speechSynthesis = { getVoices: () => voices };

    const info = await pickVoiceInfo('en', 'male');
    expect(info.status).toBe('none');
    expect(info.name).toBe('');
  });
});

// SS-23: voiceName used to be a plain string where '' meant both "still
// resolving" and "genuinely no match", so the UI could show a fallback
// placeholder AND "no fallback voice found" at the same time. pickVoiceInfo
// must keep those two states distinguishable.
describe('pickVoiceInfo distinguishes pending/ready/none (SS-23)', () => {
  let originalSynthesis;

  beforeEach(() => {
    originalSynthesis = window.speechSynthesis;
  });

  afterEach(() => {
    window.speechSynthesis = originalSynthesis;
    vi.useRealTimers();
  });

  it('reports "none" (not "pending") when the list has genuinely loaded with only en-US voices and the target language is German', async () => {
    const voices = [makeVoice('Microsoft Zira - English (United States)', 'en-US')];
    window.speechSynthesis = { getVoices: () => voices };

    const info = await pickVoiceInfo('de');
    expect(info.status).toBe('none');
    expect(info.name).toBe('');
  });

  it('reports "pending" while the voice list is still empty, then "ready" with a name once a German voice has actually loaded', async () => {
    vi.useFakeTimers();
    window.speechSynthesis = { getVoices: () => [] };

    // Nothing ever fires 'voiceschanged' here — loadVoices()'s internal wait
    // times out with the list still empty, which must read as "pending"
    // (we don't yet know), never as "none" (we definitely know there's no
    // match) — those are different claims.
    const pendingPromise = pickVoiceInfo('de');
    await vi.advanceTimersByTimeAsync(700);
    const pending = await pendingPromise;
    expect(pending.status).toBe('pending');
    expect(pending.name).toBe('');

    // The list has now genuinely loaded (this is what a real 'voiceschanged'
    // event delivers) — a fresh call resolves definitively.
    const germanVoice = makeVoice('Microsoft Hedda - German (Germany)', 'de-DE');
    window.speechSynthesis = { getVoices: () => [germanVoice] };
    const ready = await pickVoiceInfo('de');
    expect(ready.status).toBe('ready');
    expect(ready.name).toMatch(/hedda/i);
  });
});
