import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { createElement } from 'react';
import {
  render, screen, fireEvent, cleanup, act,
} from '@testing-library/react';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const apiModule = vi.fn();
const apiAsk = vi.fn();

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
  // Rejects immediately with a permanent-classified detail so the answer's
  // speak-out attempt (fire-and-forget inside submitQuestion) settles right
  // away instead of retrying — irrelevant to this suite, kept quiet.
  fetchTtsAudio: () => Promise.reject(Object.assign(new Error('tts unavailable'), { detail: 'TTS is not configured.' })),
}));

// Neither SimliAvatar nor TavusAvatar is ever mounted for the 'mira' persona
// used below, but App.jsx imports both modules unconditionally.
vi.mock('simli-client', () => ({ SimliClient: class {} }));
vi.mock('@daily-co/daily-js', () => ({ default: { createCallObject: vi.fn() } }));

const { Classroom } = await import('../src/App.jsx');

const ui = { ask: 'Ask', askPlaceholder: 'Ask a question' };
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

// SS-30: the button's disabled={asking} only reflects reality after React
// commits, so several events dispatched in the same task (no yield in
// between) all still see the pre-commit `asking === false`. These tests
// batch events inside a single, manually-driven act() call to reproduce
// exactly that — real user double-clicks / a fast Enter repeat routinely
// land in the same task on real hardware.
describe('Q&A submit is single-flight (SS-30)', () => {
  beforeEach(() => {
    apiModule.mockReset();
    apiAsk.mockReset();
    apiModule.mockResolvedValue(testMod);
  });
  afterEach(() => { cleanup(); });

  it('three synchronous clicks on Ask call api.ask exactly once', async () => {
    renderClassroom();
    const input = await screen.findByPlaceholderText('Ask a question');
    const button = screen.getByText('Ask');
    const d = deferred();
    apiAsk.mockReturnValue(d.promise);

    // Flushed on its own so the button's click handlers see the real text.
    fireEvent.change(input, { target: { value: 'What is a sprint?' } });

    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(apiAsk).toHaveBeenCalledTimes(1);
    expect(apiAsk.mock.calls[0][0].question).toBe('What is a sprint?');

    await act(async () => {
      d.resolve({ answer: 'A sprint is a fixed period.', topicality: 'on-topic' });
      await d.promise;
    });
  });

  it('pressing Enter twice in a row (different text) calls api.ask exactly once', async () => {
    renderClassroom();
    const input = await screen.findByPlaceholderText('Ask a question');
    const d = deferred();
    apiAsk.mockReturnValue(d.promise);

    fireEvent.change(input, { target: { value: 'First question' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // The first Enter is now in flight (asking === true) — a second Enter
    // moments later, before it resolves, must not fire a second request,
    // regardless of whether the text changed in between.
    fireEvent.change(input, { target: { value: 'Second question' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(apiAsk).toHaveBeenCalledTimes(1);
    expect(apiAsk.mock.calls[0][0].question).toBe('First question');

    await act(async () => {
      d.resolve({ answer: 'Answer.', topicality: 'on-topic' });
      await d.promise;
    });
  });

  it('a new question submits normally once the in-flight one resolves', async () => {
    renderClassroom();
    const input = await screen.findByPlaceholderText('Ask a question');
    const button = screen.getByText('Ask');
    const d1 = deferred();
    apiAsk.mockReturnValue(d1.promise);

    fireEvent.change(input, { target: { value: 'First question' } });
    fireEvent.click(button);
    expect(apiAsk).toHaveBeenCalledTimes(1);

    await act(async () => {
      d1.resolve({ answer: 'Answer one.', topicality: 'on-topic' });
      await d1.promise;
    });

    const d2 = deferred();
    apiAsk.mockReturnValue(d2.promise);
    fireEvent.change(input, { target: { value: 'Second question' } });
    fireEvent.click(button);

    expect(apiAsk).toHaveBeenCalledTimes(2);
    expect(apiAsk.mock.calls[1][0].question).toBe('Second question');

    await act(async () => {
      d2.resolve({ answer: 'Answer two.', topicality: 'on-topic' });
      await d2.promise;
    });
  });
});
