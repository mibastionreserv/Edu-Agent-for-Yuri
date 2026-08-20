import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  describe, it, expect, beforeAll,
} from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.CONTENT_DIR = join(__dirname, '..', '..', 'course-content');

const { chunkKnowledge, answerQuestion, tokenize } = await import('../src/qa.js');
const { loadModule } = await import('../src/content.js');

describe('knowledge chunking', () => {
  it('splits markdown into heading-keyed chunks', () => {
    const md = '## Daily Scrum\nThe Daily Scrum is fifteen minutes.\n\n## Sprint Review\nHeld at the end.';
    const chunks = chunkKnowledge(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].title).toBe('Daily Scrum');
    expect(chunks[0].text).toContain('fifteen minutes');
  });

  it('drops stop words and punctuation when tokenizing', () => {
    expect(tokenize('How long is the Daily Scrum?')).toContain('daily');
    expect(tokenize('How long is the Daily Scrum?')).not.toContain('the');
  });
});

describe('grounded Q&A business flow (Practical Scrum - Events module)', () => {
  let chunks;
  beforeAll(() => {
    const mod = loadModule('m2-events', 'en');
    chunks = mod.knowledgeChunks;
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('answers an on-topic question from the module knowledge', () => {
    const res = answerQuestion({ question: 'How long is the Daily Scrum?', lang: 'en', chunks });
    expect(res.topicality).toBe('on');
    expect(res.answer.toLowerCase()).toMatch(/fifteen/);
    expect(res.source).toBe('Daily Scrum');
  });

  it('deflects an off-topic question without fabricating an answer', () => {
    const res = answerQuestion({ question: 'What is the weather tomorrow?', lang: 'en', chunks });
    expect(res.topicality).toBe('off');
    expect(res.answer).toMatch(/outside/i);
    expect(res.source).toBeNull();
  });

  it('deflects in German for off-topic questions', () => {
    const res = answerQuestion({ question: 'Wie ist das Wetter morgen?', lang: 'de', chunks });
    expect(res.topicality).toBe('off');
    expect(res.answer).toMatch(/au.erhalb/i);
  });

  it('composes a comparison from two concepts', () => {
    const res = answerQuestion({
      question: 'What is the difference between the Sprint Review and the Sprint Retrospective?',
      lang: 'en',
      chunks,
    });
    expect(res.topicality).toBe('on');
    expect(res.intent).toBe('compare');
    expect(res.sources.length).toBe(2);
    expect(res.answer.toLowerCase()).toContain('review');
    expect(res.answer.toLowerCase()).toContain('retrospective');
  });

  it('resolves a follow-up using the previous question as context', () => {
    const history = [
      { role: 'learner', text: 'Tell me about the Daily Scrum' },
      { role: 'presenter', text: 'The Daily Scrum is timeboxed to fifteen minutes.' },
    ];
    const res = answerQuestion({ question: 'And why?', lang: 'en', chunks, history });
    expect(res.topicality).toBe('on');
    expect(res.intent).toBe('why');
    expect(res.answer.toLowerCase()).toMatch(/reason|fifteen/);
  });
});

describe('grounded Q&A business flow (Practical Scrum - Roles module) - SS-17', () => {
  let chunks;
  beforeAll(() => {
    const mod = loadModule('m1-roles', 'en');
    chunks = mod.knowledgeChunks;
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('answers "What does the Scrum Master do?" from the Scrum Master heading, not an earlier tied heading', () => {
    const res = answerQuestion({ question: 'What does the Scrum Master do?', lang: 'en', chunks });
    expect(res.topicality).toBe('on');
    expect(res.source).toBe('Scrum Master');
    expect(res.answer.toLowerCase()).toMatch(/accountable for the team's effectiveness/);
  });

  it('does not fabricate an answer for material this module does not cover (Sprint Goal is an events-module topic)', () => {
    const res = answerQuestion({ question: 'What is the Sprint Goal?', lang: 'en', chunks });
    expect(res.topicality).toBe('off');
    expect(res.source).toBeNull();
  });

  it('keeps ranking stable when chunk order is shuffled (source must not depend on file order)', () => {
    const shuffled = [...chunks].reverse();
    const res = answerQuestion({ question: 'What does the Scrum Master do?', lang: 'en', chunks: shuffled });
    expect(res.source).toBe('Scrum Master');
  });
});

describe('multilingual grounding (Italian, Greek, metrics)', () => {
  it('answers an on-topic Italian question from the Italian knowledge base', () => {
    const mod = loadModule('m2-events', 'it');
    const res = answerQuestion({ question: 'Quanto dura il Daily Scrum?', lang: 'it', chunks: mod.knowledgeChunks });
    expect(res.topicality).toBe('on');
    expect(res.answer.toLowerCase()).toMatch(/quindici/);
  });

  it('deflects an off-topic Greek question in Greek', () => {
    const mod = loadModule('m2-events', 'el');
    const res = answerQuestion({ question: 'Poia tainia na do apopse einai kali?', lang: 'el', chunks: mod.knowledgeChunks });
    expect(res.topicality).toBe('off');
  });

  it('answers an on-topic metrics question (velocity) in English', () => {
    const mod = loadModule('m3-metrics', 'en');
    const res = answerQuestion({ question: 'What is velocity?', lang: 'en', chunks: mod.knowledgeChunks });
    expect(res.topicality).toBe('on');
    expect(res.answer.toLowerCase()).toMatch(/story points|forecast|team/);
  });
});

// SS-17: the original bug was that `source` depended on where a heading sat
// in the markdown file (stable-sort tie-breaking), not on relevance. These
// property tests shuffle both chunk order and sentence order within a chunk
// for a small golden set and assert the picked `source` never moves.
describe('ranking is order-independent (SS-17 regression guard)', () => {
  const golden = [
    { mod: 'm1-roles', lang: 'en', q: 'What does the Scrum Master do?', expectedSource: 'Scrum Master' },
    { mod: 'm1-roles', lang: 'en', q: 'What is the Product Owner?', expectedSource: 'Product Owner' },
    { mod: 'm2-events', lang: 'en', q: 'How long is the Daily Scrum?', expectedSource: 'Daily Scrum' },
    { mod: 'm2-events', lang: 'en', q: 'What is the Sprint Review?', expectedSource: 'Sprint Review' },
    { mod: 'm3-metrics', lang: 'en', q: 'What is velocity?', expectedSource: 'Velocity' },
  ];

  // Deterministic (seeded) shuffle so the test is stable across CI runs.
  function seededShuffle(arr, seed) {
    const a = [...arr];
    let s = seed;
    for (let i = a.length - 1; i > 0; i -= 1) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const j = s % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function shuffleChunkSentences(chunk, seed) {
    const sentences = chunk.text.split(/(?<=[.!?])\s+/).filter(Boolean);
    return { ...chunk, text: seededShuffle(sentences, seed).join(' ') };
  }

  for (const { mod, lang, q, expectedSource } of golden) {
    it(`"${q}" (${mod}/${lang}) keeps source "${expectedSource}" under chunk and sentence reordering`, () => {
      const base = loadModule(mod, lang).knowledgeChunks;
      for (let seed = 1; seed <= 5; seed += 1) {
        const shuffledChunks = seededShuffle(base, seed).map((c) => shuffleChunkSentences(c, seed + 100));
        const res = answerQuestion({ question: q, lang, chunks: shuffledChunks });
        expect(res.source).toBe(expectedSource);
      }
    });
  }
});

// SS-21: the compare branch used to gate on `score > 0` instead of the same
// CHUNK_RELEVANCE_THRESHOLD as the main path, so almost any "compare"-shaped
// question was answered "on topic" even when the module doesn't cover the
// named subjects at all — and when it did resolve, the two halves could
// silently duplicate (same chunk/sentence picked twice) with a hardcoded
// confidence:0.6 regardless of how weak the match actually was.
describe('compare-intent questions respect the topicality gate (SS-21)', () => {
  it('does not let a comparison bypass the gate: neither subject is covered by this module', () => {
    const chunks = loadModule('m1-roles', 'en').knowledgeChunks;
    const res = answerQuestion({
      question: 'What is the difference between Sprint Review and Sprint Retrospective?',
      lang: 'en',
      chunks,
    });
    expect(res.topicality).toBe('off');
    expect(res.source).toBeNull();
    expect(res.sources).toEqual([]);
  });

  it('answers a "differ from" phrased comparison with two distinct, non-duplicated sources', () => {
    const chunks = loadModule('m2-events', 'en').knowledgeChunks;
    const res = answerQuestion({
      question: 'How does the Daily Scrum differ from the Sprint Retrospective?',
      lang: 'en',
      chunks,
    });
    expect(res.topicality).toBe('on');
    expect(res.intent).toBe('compare');
    expect(res.sources.length).toBe(2);
    expect(new Set(res.sources).size).toBe(2);
    expect(res.answer.toLowerCase()).toContain('daily');
    expect(res.answer.toLowerCase()).toContain('retrospective');
  });

  it('still composes a comparison from two concepts (existing behavior unchanged)', () => {
    const chunks = loadModule('m2-events', 'en').knowledgeChunks;
    const res = answerQuestion({
      question: 'What is the difference between the Sprint Review and the Sprint Retrospective?',
      lang: 'en',
      chunks,
    });
    expect(res.topicality).toBe('on');
    expect(res.intent).toBe('compare');
    expect(res.sources.length).toBe(2);
    expect(res.answer.toLowerCase()).toContain('review');
    expect(res.answer.toLowerCase()).toContain('retrospective');
  });

  // Regression guard: the hardcoded confidence:0.6 and duplicated-source bug
  // must not resurface across a small set of genuine compare questions.
  it('never returns the old hardcoded confidence:0.6 or duplicated sources for a compare answer', () => {
    const cases = [
      { mod: 'm2-events', lang: 'en', q: 'What is the difference between the Sprint Review and the Sprint Retrospective?' },
      { mod: 'm2-events', lang: 'en', q: 'How does the Daily Scrum differ from the Sprint Retrospective?' },
      { mod: 'm1-roles', lang: 'en', q: 'What is the difference between the Product Owner and the Scrum Master?' },
      { mod: 'm3-metrics', lang: 'en', q: 'What is the difference between Lead Time and Cycle Time?' },
    ];
    for (const { mod, lang, q } of cases) {
      const chunks = loadModule(mod, lang).knowledgeChunks;
      const res = answerQuestion({ question: q, lang, chunks });
      if (res.intent === 'compare' && res.topicality === 'on') {
        expect(res.confidence).not.toBe(0.6);
        expect(new Set(res.sources).size).toBe(res.sources.length);
      }
    }
  });
});

// SS-22: confidence is computed but was never exposed as anything a caller
// could act on — a near-zero-confidence answer looked exactly as assertive
// as a well-grounded one, and the "off" branch didn't even return the field.
describe('certainty is derived from confidence and set on every branch (SS-22)', () => {
  it('sets certainty on the off-topic branch', () => {
    const chunks = loadModule('m2-events', 'en').knowledgeChunks;
    const res = answerQuestion({ question: 'What is the weather tomorrow?', lang: 'en', chunks });
    expect(res.topicality).toBe('off');
    expect(res.certainty).toBe('low');
  });

  it('a strong, well-grounded on-topic answer is certainty:"high"', () => {
    const chunks = loadModule('m2-events', 'en').knowledgeChunks;
    const goodQuestions = [
      'How long is the Daily Scrum?',
      'What is the Sprint Review?',
      'What is the Sprint Retrospective?',
    ];
    for (const q of goodQuestions) {
      const res = answerQuestion({ question: q, lang: 'en', chunks });
      expect(res.topicality).toBe('on');
      expect(res.certainty).toBe('high');
    }
  });

  it('a weak/ambiguous on-topic match is downgraded to certainty:"low" and hedged', () => {
    // A minimal, deliberately ambiguous corpus: two headings share almost
    // all of their vocabulary, so neither one wins by a clear margin.
    const chunks = [
      { title: 'Sprint Planning', text: 'Sprint Planning starts the Sprint and sets the Sprint Goal for the team.' },
      { title: 'Sprint Review', text: 'Sprint Review happens near the end of the Sprint for the team and Goal.' },
    ];
    const res = answerQuestion({ question: 'Tell me about the Sprint and the Goal for the team.', lang: 'en', chunks });
    expect(res.topicality).toBe('on');
    expect(res.certainty).toBe('low');
    expect(res.confidence).toBeLessThan(0.15);
  });
});
