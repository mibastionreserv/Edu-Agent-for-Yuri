// Single source of truth for the shape of a Q&A answer and where each field
// is allowed to come from. Both the local grounded composer (qa.js) and the
// LLM branch (answerProvider.js) must pass their result through
// normalizeAnswer() before returning it from getAnswer() — this is the only
// place that decides what each field means and what values it may hold.
//
// Field names/values are kept backward compatible with what
// frontend/src/App.jsx already reads (topicality, source, sources, certainty).
export function normalizeAnswer(raw, { provider }) {
  return {
    topicality: raw.topicality === 'off' ? 'off' : 'on',
    answer: String(raw.answer || ''),
    source: raw.source ?? null,
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    intent: raw.intent || 'define',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
    certainty: raw.certainty === 'low' ? 'low' : (raw.certainty === 'high' ? 'high' : null),
    provider,
  };
}
