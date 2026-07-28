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
