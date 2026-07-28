// Pure helpers, kept free of React so they can be unit-tested directly.

// Splits `text` into tokens marking any occurrence of the given phrases so the
// UI can highlight the words a whiteboard cue is anchored to.
export function highlightKeywords(text, phrases = []) {
  if (!text) return [];
  const clean = phrases.filter(Boolean).sort((a, b) => b.length - a.length);
  if (clean.length === 0) return [{ text, hl: false }];

  const escaped = clean.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);
  const lower = new Set(clean.map((p) => p.toLowerCase()));
  return parts
    .filter((p) => p.length > 0)
    .map((p) => ({ text: p, hl: lower.has(p.toLowerCase()) }));
}

// Extracts the afterPhrase trigger values from a segment's cues.
export function cuePhrases(segment) {
  if (!segment || !Array.isArray(segment.cues)) return [];
  return segment.cues
    .filter((c) => c.trigger && c.trigger.type === 'afterPhrase')
    .map((c) => c.trigger.value);
}

// Chooses a localized value from a { en, de } style map with fallback.
export function pickLang(map, lang, fallback = 'en') {
  if (!map) return '';
  return map[lang] ?? map[fallback] ?? '';
}
