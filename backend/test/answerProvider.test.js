import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

const { getAnswer } = await import('../src/answerProvider.js');
const { answerQuestion } = await import('../src/qa.js');

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: 'ok',
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() { return this; },
  };
}

function llmChoice(content) {
  return jsonResponse({ choices: [{ message: { content } }] });
}

const module_ = {
  title: 'Scrum Events',
  knowledgeChunks: [
    { title: 'Daily Scrum', text: 'The Daily Scrum is a fifteen-minute event for the Developers.' },
    { title: 'Sprint Review', text: 'The Sprint Review is held at the end of the Sprint to inspect the Increment.' },
  ],
};

describe('getAnswer (SS-27)', () => {
  let originalBase;
  let originalKey;
  let originalFetch;

  beforeEach(() => {
    originalBase = process.env.LLM_BASE_URL;
    originalKey = process.env.LLM_API_KEY;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalBase === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = originalBase;
    if (originalKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = originalKey;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('falls back to the local engine when no LLM is configured, normalized through the contract', async () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;

    const res = await getAnswer({
      question: 'How long is the Daily Scrum?', lang: 'en', module: module_,
    });

    expect(res.provider).toBe('local');
    expect(res.topicality).toBe('on');
    expect(res.answer.toLowerCase()).toMatch(/fifteen/);
    // Contract fields must all be present, even when the raw local answer
    // didn't set every one of them explicitly.
    expect(res).toHaveProperty('source');
    expect(res).toHaveProperty('sources');
    expect(res).toHaveProperty('intent');
    expect(res).toHaveProperty('confidence');
    expect(res).toHaveProperty('certainty');
  });

  it('uses the TOPICALITY tag the LLM returns, and strips it from the visible answer', async () => {
    process.env.LLM_BASE_URL = 'https://example.test/v1';
    process.env.LLM_API_KEY = 'test-key';
    global.fetch = vi.fn().mockResolvedValue(
      llmChoice("TOPICALITY: off\n\nSorry, that's a bit beyond this part of the course."),
    );

    const res = await getAnswer({
      question: 'What is the airspeed velocity of an unladen swallow?', lang: 'en', module: module_,
    });

    expect(res.provider).toBe('llm');
    expect(res.topicality).toBe('off');
    expect(res.answer).not.toMatch(/TOPICALITY/);
    expect(res.answer).toMatch(/beyond this part of the course/i);
  });

  it('falls back to the local topicality (with a logged warning) when the LLM omits the tag', async () => {
    process.env.LLM_BASE_URL = 'https://example.test/v1';
    process.env.LLM_API_KEY = 'test-key';
    global.fetch = vi.fn().mockResolvedValue(
      llmChoice('The Daily Scrum is a short daily check-in for the Developers.'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const question = 'How long is the Daily Scrum?';
    const expectedLocal = answerQuestion({ question, lang: 'en', chunks: module_.knowledgeChunks });

    const res = await getAnswer({ question, lang: 'en', module: module_ });

    expect(res.provider).toBe('llm');
    expect(res.topicality).toBe(expectedLocal.topicality);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/no TOPICALITY tag/i));
  });

  it('falls back to the local engine when the LLM call errors out', async () => {
    process.env.LLM_BASE_URL = 'https://example.test/v1';
    process.env.LLM_API_KEY = 'test-key';
    global.fetch = vi.fn().mockRejectedValue(new Error('network timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await getAnswer({
      question: 'How long is the Daily Scrum?', lang: 'en', module: module_,
    });

    expect(res.provider).toBe('local');
    expect(res.topicality).toBe('on');
    expect(res.answer.toLowerCase()).toMatch(/fifteen/);
  });
});
