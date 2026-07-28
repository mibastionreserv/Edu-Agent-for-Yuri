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

function overlap(qTokens, text) {
  const set = new Set(tokenize(text));
  let n = 0;
  for (const t of qTokens) if (set.has(t)) n += 1;
  return qTokens.length ? n / qTokens.length : 0;
}

// Flatten chunks into scored sentences.
function rankSentences(qTokens, chunks) {
  const out = [];
  for (const c of chunks) {
    for (const s of splitSentences(c.text)) {
      out.push({ text: s, title: c.title, score: overlap(qTokens, `${c.title} ${s}`) });
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

function bestChunkForSubject(subject, chunks) {
  const st = tokenize(subject);
  let best = null; let bestScore = 0;
  for (const c of chunks) {
    const s = overlap(st, c.title) * 2 + overlap(st, c.text);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return bestScore > 0 ? best : null;
}

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

  // Comparison: pull the best sentence for each named subject.
  if (intent === 'compare') {
    const subjects = extractSubjects(question);
    if (subjects.length === 2 && inScope) {
      const parts = [];
      const sources = [];
      for (const subj of subjects) {
        const chunk = bestChunkForSubject(subj, chunks);
        if (chunk) {
          const top = rankSentences([...tokenize(subj), ...retrievalTokens], [chunk])[0];
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

  const ranked = rankSentences(retrievalTokens, chunks);
  const best = ranked[0];
  const RETRIEVAL_THRESHOLD = 0.16;
  const onTopic = inScope && best && best.score >= RETRIEVAL_THRESHOLD;

  if (!onTopic) {
    return { topicality: 'off', answer: DEFLECTION[L], source: null, sources: [], intent };
  }

  // Compose from the top sentence plus the next distinct supporting sentence
  // from the same concept, so the answer reads as an explanation, not a snippet.
  const primary = best.text;
  const support = ranked.slice(1).find(
    (s) => s.title === best.title && s.text !== primary && s.score >= 0.1,
  );
  let body = support ? `${primary} ${support.text}` : primary;
  if ((intent === 'why' || intent === 'example') && !new RegExp(LEAD[intent][L].slice(0, 6), 'i').test(body)) {
    body = LEAD[intent][L] + body.charAt(0).toLowerCase() + body.slice(1);
  }

  const sources = [best.title, ...(support ? [support.title] : [])]
    .filter((v, i, a) => a.indexOf(v) === i);
  return {
    topicality: 'on', answer: body, source: best.title, sources,
    intent, confidence: Number(best.score.toFixed(2)),
  };
}
