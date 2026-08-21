import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { createElement } from 'react';
import {
  render, screen, cleanup, act, fireEvent,
} from '@testing-library/react';
import * as ttsCircuit from '../src/ttsCircuit.js';

function transientErr() {
  // 5xx with no structured `detail` classifies as 'transient' in
  // ttsCircuit.js — it never opens the circuit, so the answer still falls
  // back to the (mocked) browser voice below instead of skipping speech.
  const e = new Error('tts failed 500');
  e.status = 500;
  e.detail = '';
  return e;
}

const apiModule = vi.fn();
const apiAsk = vi.fn();
const fetchTtsAudio = vi.fn();

vi.mock('../src/api.js', () => ({
  api: {
    module: (...a) => apiModule(...a),
    ask: (...a) => apiAsk(...a),
    simliToken: vi.fn(),
    simliIce: vi.fn(),
    tavusStart: vi.fn(),
    tavusEnd: vi.fn(),
  },
  getToken: () => null,
  setToken: () => {},
  fetchTtsAudio: (...a) => fetchTtsAudio(...a),
}));

vi.mock('simli-client', () => ({ SimliClient: class {} }));
vi.mock('@daily-co/daily-js', () => ({ default: { createCallObject: vi.fn() } }));

// Both callbacks fire synchronously, back to back — the fallback voice
// speaks the answer and finishes it in the same tick, which is enough to
// exercise "the answer has been fully spoken" without depending on jsdom's
// (nonexistent) speechSynthesis implementation.
vi.mock('../src/speech.js', () => ({
  speak: vi.fn((text, lang, opts) => { opts.onStart(); opts.onEnd(); return Promise.resolve(() => {}); }),
  cancelSpeech: vi.fn(),
  pickVoiceInfo: vi.fn(() => new Promise(() => {})),
  speechSupported: vi.fn(() => true),
  langTag: vi.fn(() => 'en-US'),
}));

const { Classroom } = await import('../src/App.jsx');

const ui = {
  ask: 'Ask', askPlaceholder: 'Ask a question', thinking: 'Thinking…', speaking: 'Speaking', listening: 'Listening',
};
const course = { title: 'Course', avatars: [{ id: 'mira', name: 'Mira' }] };
const testMod = {
  title: 'Module 1',
  segments: [{ text: 'Hello there.', steps: [] }],
  check: null,
};

function renderClassroom() {
  return render(createElement(Classroom, {
    ui,
    lang: 'en',
    avatarId: 'mira',
    course,
    moduleId: 'm1',
    initialSegment: 0,
    onExit: vi.fn(),
    onSaved: vi.fn(),
  }));
}

// This iteration's ticket: the "Listening" badge was driven by `handUp`
// alone, which stays true for the whole Q&A session (until the learner
// explicitly lowers their hand) — so it kept reading "Listening" long after
// an answer had been fully displayed and spoken, even though nothing was
// actually listening (the learner was in typed-question mode, no mic open).
describe('the presenter badge does not stay stuck on "Listening" after a Q&A answer has been shown and spoken', () => {
  beforeEach(() => {
    apiModule.mockReset();
    apiModule.mockResolvedValue(testMod);
    apiAsk.mockReset();
    fetchTtsAudio.mockReset();
    fetchTtsAudio.mockRejectedValue(transientErr());
    ttsCircuit._resetForTests();
  });
  afterEach(() => { cleanup(); });

  it('falls back to the presenter name once thinking/speaking are both done, instead of "Listening" (typed Q&A, mic never opened)', async () => {
    const { container } = renderClassroom();
    const input = await screen.findByPlaceholderText('Ask a question');
    const button = screen.getByText('Ask');
    const badge = () => container.querySelector('.badge')?.textContent || '';

    let resolveAsk;
    apiAsk.mockReturnValue(new Promise((r) => { resolveAsk = r; }));

    fireEvent.change(input, { target: { value: 'What is a sprint?' } });
    fireEvent.click(button);

    expect(badge()).toBe(ui.thinking);

    await act(async () => {
      resolveAsk({ answer: 'A sprint is a fixed period.', topicality: 'on-topic' });
      // speakWithMouth's retry-on-transient-failure backs off 800ms before
      // falling through to the (mocked) browser voice.
      await new Promise((r) => { setTimeout(r, 900); });
    });

    expect(screen.getByText('A sprint is a fixed period.')).toBeTruthy();
    expect(badge()).toBe('Mira');
    expect(badge()).not.toBe(ui.listening);
  });
});
