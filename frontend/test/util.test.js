import { describe, it, expect } from 'vitest';
import { highlightKeywords, cuePhrases, pickLang } from '../src/util.js';

describe('highlightKeywords', () => {
  it('marks the cue phrase inside the caption text', () => {
    const parts = highlightKeywords('A Sprint is two to four weeks long.', ['two to four weeks']);
    const highlighted = parts.filter((p) => p.hl).map((p) => p.text.toLowerCase());
    expect(highlighted).toContain('two to four weeks');
    // reassembling parts reproduces the original text
    expect(parts.map((p) => p.text).join('')).toBe('A Sprint is two to four weeks long.');
  });

  it('returns a single plain part when there are no phrases', () => {
    const parts = highlightKeywords('Plain text', []);
    expect(parts).toEqual([{ text: 'Plain text', hl: false }]);
  });
});

describe('cuePhrases', () => {
  it('extracts afterPhrase trigger values only', () => {
    const segment = {
      cues: [
        { trigger: { type: 'afterPhrase', value: 'usable increment' }, action: 'show' },
        { trigger: { type: 'atEnd' }, action: 'gesture' },
      ],
    };
    expect(cuePhrases(segment)).toEqual(['usable increment']);
  });
});

describe('pickLang', () => {
  it('falls back to english when the language is missing', () => {
    expect(pickLang({ en: 'Sprint', de: 'Sprint' }, 'de')).toBe('Sprint');
    expect(pickLang({ en: 'Roles' }, 'de')).toBe('Roles');
  });
});
