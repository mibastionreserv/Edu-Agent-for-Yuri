// Grounded, intelligent Q&A composer.
// Deterministic and pure so it runs with no API key and is unit-testable. It
// retrieves at sentence granularity and *composes* a conversational answer
// (definition, comparison, "why", example, follow-up) rather than pasting a raw
// passage. An optional LLM provider (see answerProvider.js) can replace the
// composition step; this module always remains the grounded fallback.

const SCOPE_TERMS = new Set([
  'scrum', 'sprint', 'sprints', 'backlog', 'increment', 'product', 'owner',
  'master', 'developer', 'developers', 'daily', 'planning', 'review',
  'retrospective', 'retro', 'ceremony', 'ceremonies', 'event', 'events',
  'role', 'roles', 'artifact', 'artifacts', 'timebox', 'timeboxed', 'goal',
  'team', 'empiricism', 'transparency', 'inspection', 'adaptation', 'value',
  'values', 'stakeholder', 'stakeholders', 'definition', 'done',
  // metrics & flow (modules 3-5)
  'velocity', 'burndown', 'story', 'points', 'point', 'metric', 'metrics',
  'lead', 'cycle', 'flow', 'refinement', 'estimate', 'estimates', 'commitment',
  'commitments', 'antipattern', 'anti', 'pattern', 'patterns', 'impediment', 'impediments',
  // German
  'zeremonie', 'zeremonien', 'rolle', 'rollen', 'ereignis', 'ereignisse',
  'planung', 'ueberpruefung', 'anpassung', 'ziel', 'wert', 'nutzbares',
  'geschwindigkeit', 'kennzahl', 'kennzahlen', 'durchlaufzeit', 'zykluszeit', 'hindernis',
  // Italian
  'ruolo', 'ruoli', 'evento', 'eventi', 'cerimonia', 'cerimonie', 'incremento',
  'obiettivo', 'valore', 'valori', 'metrica', 'metriche', 'impedimento', 'artefatto', 'artefatti',
  // Greek (diacritics stripped by tokenize)
  'σκραμ', 'σπριντ', 'ρολος', 'ρολοι', 'ρολο', 'γεγονος', 'γεγονοτα', 'τελετη',
  'μετρικη', 'μετρικες', 'αξια', 'αξιες', 'ομαδα', 'στοχος', 'εμποδιο', 'ταχυτητα',
  'επιθεωρηση', 'προσαρμογη', 'διαφανεια',
]);

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'for',
  'what', 'how', 'why', 'who', 'when', 'does', 'do', 'it', 'that', 'this',
  'der', 'die', 'das', 'ein', 'eine', 'ist', 'sind', 'und', 'oder', 'wie',
  'was', 'warum', 'wer', 'wann', 'zu', 'von', 'im', 'fuer', 'lang', 'me',
  'il', 'lo', 'la', 'un', 'una', 'che', 'come', 'perche', 'chi', 'quando', 'del', 'della',
  'ο', 'η', 'το', 'τι', 'πως', 'γιατι', 'ποιος', 'ποτε', 'ενα', 'μια', 'του', 'της', 'και',
]);

export function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

// Split a knowledge markdown file into chunks keyed by their heading.
export function chunkKnowledge(markdown) {
  const chunks = [];
  let current = null;
  for (const raw of (markdown || '').split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      if (current) chunks.push(current);
      current = { title: heading[1].trim(), text: '' };
    } else if (current) {
      current.text += (current.text ? ' ' : '') + line.trim();
    }
  }
  if (current) chunks.push(current);
  return chunks
    .map((c) => ({ ...c, text: c.text.trim() }))
    .filter((c) => c.text.length > 0);
}

function splitSentences(text) {
  return (text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// IDF over the current module's own chunks (chunks are already scoped to one
// module/language by content.js) so a word present in almost every chunk
// ("scrum") counts for far less than a distinctive one ("velocity").
function buildIdf(chunks) {
  const df = new Map();
  const N = chunks.length || 1;
  for (const c of chunks) {
    for (const t of new Set(tokenize(`${c.title} ${c.text}`))) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + N / (d + 1)));
  return idf;
}

// A token never seen in this module's corpus (e.g. "long" in "How long is
// the Daily Scrum?") gets a neutral weight rather than an inflated one.
function weight(t, idf) {
  return idf.has(t) ? idf.get(t) : Math.log(2);
}

// What fraction (by IDF weight) of qTokens are found in the target text.
function recall(qTokens, text, idf) {
  const set = new Set(tokenize(text));
  let num = 0; let den = 0;
  for (const t of qTokens) {
    const w = weight(t, idf);
    den += w;
    if (set.has(t)) num += w;
  }
  return den ? num / den : 0;
}

// What fraction (by IDF weight) of the target's own tokens are also in the
// query - punishes a long, mostly-unrelated chunk that shares one word.
function precision(qTokens, text, idf) {
  const qSet = new Set(qTokens);
  let num = 0; let den = 0;
  for (const t of tokenize(text)) {
    const w = weight(t, idf);
    den += w;
    if (qSet.has(t)) num += w;
  }
  return den ? num / den : 0;
}

function f1(p, r) {
  return (p + r) ? (2 * p * r) / (p + r) : 0;
}

// Chunk-level relevance: title-match (weighted double - a heading that names
// the concept is the strongest signal) combined with body-evidence, since
// some answers live in a chunk's body rather than its heading.
function scoreChunk(qTokens, chunk, idf) {
  const titleScore = f1(precision(qTokens, chunk.title, idf), recall(qTokens, chunk.title, idf));
  const bodyScore = f1(precision(qTokens, chunk.text, idf), recall(qTokens, chunk.text, idf));
  return titleScore * 2 + bodyScore;
}

function rankChunks(qTokens, chunks, idf) {
  return chunks
    .map((chunk) => ({ chunk, score: scoreChunk(qTokens, chunk, idf) }))
    .sort((a, b) => b.score - a.score);
}

// Flatten (a subset of) chunks into scored sentences - used AFTER a chunk has
// already been selected, so ties are resolved by content (recall+precision),
// never by position in the source file. Scored on the sentence text alone
// (not "title + sentence"): every sentence in the winning chunk already
// shares the same title match, so folding it back in here would only dilute
// precision toward whichever sentence happens to be shortest.
function rankSentences(qTokens, chunks, idf) {
  const out = [];
  for (const c of chunks) {
    for (const s of splitSentences(c.text)) {
      out.push({ text: s, title: c.title, score: f1(precision(qTokens, s, idf), recall(qTokens, s, idf)) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const DEFLECTION = {
  en: "That's a bit outside what we're covering in this topic. Do you have another question, or shall I continue?",
  de: 'Das liegt etwas außerhalb dessen, was wir in diesem Thema behandeln. Hast du noch eine Frage, oder soll ich fortfahren?',
  it: 'Questo è un po’ fuori da ciò che stiamo trattando in questo argomento. Hai un’altra domanda o vado avanti?',
  el: 'Αυτό είναι λίγο εκτός από όσα καλύπτουμε σε αυτή την ενότητα. Έχεις κάποια άλλη ερώτηση ή να συνεχίσω;',
};
const LEAD = {
  why: {
    en: 'The reason is this: ', de: 'Der Grund ist folgender: ',
    it: 'Il motivo è questo: ', el: 'Ο λόγος είναι ο εξής: ',
  },
  example: {
    en: 'Here is how that shows up in practice: ', de: 'So zeigt sich das in der Praxis: ',
    it: 'Ecco come si manifesta nella pratica: ', el: 'Να πώς φαίνεται στην πράξη: ',
  },
};

function detectIntent(q) {
  const s = q.toLowerCase();
  if (/\b(difference|differ|compare|versus|vs|unterschied|verglich|gegen(?:ü|ue)ber|differenza|differenze|διαφορα)\b/.test(s)
    || /\bbetween\b.+\band\b/.test(s) || /\bzwischen\b.+\bund\b/.test(s) || /\btra\b.+\be\b/.test(s)) return 'compare';
  if (/\b(example|instance|e\.?g\.?|beispiel|z\.?b\.?|esempio|παραδειγμα)\b/.test(s)) return 'example';
  if (/\b(why|reason|warum|wieso|weshalb|perche|perché|γιατι)\b/.test(s)) return 'why';
  return 'define';
}

function extractSubjects(q) {
  let m = q.match(/between\s+(.+?)\s+and\s+(.+?)[?.!]*$/i) || q.match(/zwischen\s+(.+?)\s+und\s+(.+?)[?.!]*$/i)
    || q.match(/tra\s+(.+?)\s+e\s+(.+?)[?.!]*$/i);
  if (m) return [m[1], m[2]];
  m = q.split(/\s+(?:vs\.?|versus)\s+/i);
  if (m.length === 2) return [m[0].replace(/.*\b(difference|compare)\b/i, ''), m[1]];
  return [];
}

function bestChunkForSubject(subject, chunks, idf) {
  const ranked = rankChunks(tokenize(subject), chunks, idf ?? buildIdf(chunks));
  return ranked[0] && ranked[0].score > 0 ? ranked[0].chunk : null;
}

// Minimum chunk score (see scoreChunk) for the module to be considered "on
// topic" for this question. Calibrated against the golden-set questions in
// qa.test.js; a chunk that only shares one incidental word with the query
// (e.g. "Sprint Goal" asked in the roles module, which only has "Product
// Goal") scores well under this, a genuine heading match scores well over it.
const CHUNK_RELEVANCE_THRESHOLD = 0.45;

// answerQuestion({ question, lang, chunks, history }) ->
//   { topicality, answer, source, sources, intent, confidence }
export function answerQuestion({ question, lang = 'en', chunks = [], history = [] }) {
  const L = ['de', 'it', 'el'].includes(lang) ? lang : 'en';
  const qTokens = tokenize(question);

  // Follow-up handling: if the question carries no course vocabulary of its own
  // (e.g. "Why?", "and the Daily?"), borrow scope from the previous learner turn.
  const prevLearner = [...history].reverse().find((h) => h.role === 'learner');
  const selfInScope = qTokens.some((t) => SCOPE_TERMS.has(t));
  const retrievalTokens = selfInScope ? qTokens : [...qTokens, ...tokenize(prevLearner ? prevLearner.text : '')];
  const inScope = retrievalTokens.some((t) => SCOPE_TERMS.has(t));

  const intent = detectIntent(question);
  const idf = buildIdf(chunks);

  // Comparison: pull the best sentence for each named subject.
  if (intent === 'compare') {
    const subjects = extractSubjects(question);
    if (subjects.length === 2 && inScope) {
      const parts = [];
      const sources = [];
      for (const subj of subjects) {
        const chunk = bestChunkForSubject(subj, chunks, idf);
        if (chunk) {
          const top = rankSentences([...tokenize(subj), ...retrievalTokens], [chunk], idf)[0];
          if (top) { parts.push(top.text); sources.push(chunk.title); }
        }
      }
      if (parts.length === 2) {
        return {
          topicality: 'on', answer: parts.join(' '), source: sources[0],
          sources, intent, confidence: 0.6,
        };
      }
    }
  }

  // Chunk-first: pick the best-matching chunk for the whole module (not a
  // course-wide keyword dictionary), then rank sentences only within it -
  // this is what actually fixes source picking the wrong heading on ties.
  const chunkRanking = rankChunks(retrievalTokens, chunks, idf);
  const bestChunk = chunkRanking[0];
  const runnerUp = chunkRanking.find((e) => e.chunk !== bestChunk?.chunk);
  const onTopic = bestChunk && bestChunk.score >= CHUNK_RELEVANCE_THRESHOLD;

  if (!onTopic) {
    return { topicality: 'off', answer: DEFLECTION[L], source: null, sources: [], intent };
  }

  const ranked = rankSentences(retrievalTokens, [bestChunk.chunk], idf);
  const best = ranked[0];

  // Compose from the top sentence plus the next distinct supporting sentence
  // from the same concept, so the answer reads as an explanation, not a snippet.
  const primary = best.text;
  const support = ranked.slice(1).find((s) => s.text !== primary && s.score >= 0.1);
  let body = support ? `${primary} ${support.text}` : primary;
  if ((intent === 'why' || intent === 'example') && !new RegExp(LEAD[intent][L].slice(0, 6), 'i').test(body)) {
    body = LEAD[intent][L] + body.charAt(0).toLowerCase() + body.slice(1);
  }

  // Confidence tracks the MARGIN between this chunk and the next-best chunk
  // from elsewhere in the module, not the raw score - a chunk that "wins" by
  // a hair over several other equally-plausible chunks is not a confident
  // answer, even if its absolute score looks high.
  const margin = runnerUp ? (bestChunk.score - runnerUp.score) / bestChunk.score : 1;
  const confidence = Number(Math.max(0, Math.min(1, margin)).toFixed(2));

  return {
    topicality: 'on', answer: body, source: bestChunk.chunk.title, sources: [bestChunk.chunk.title],
    intent, confidence,
  };
}
