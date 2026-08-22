import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { createElement } from 'react';
import {
  render, screen, cleanup, fireEvent, waitFor,
} from '@testing-library/react';
import * as ttsCircuit from '../src/ttsCircuit.js';

const apiCourse = vi.fn();
const apiUiStrings = vi.fn();
const apiGetProgress = vi.fn();
const apiModule = vi.fn();
const apiSaveProgress = vi.fn();
const fetchTtsAudio = vi.fn();

vi.mock('../src/api.js', () => ({
  api: {
    course: (...a) => apiCourse(...a),
    uiStrings: (...a) => apiUiStrings(...a),
    getProgress: (...a) => apiGetProgress(...a),
    module: (...a) => apiModule(...a),
    saveProgress: (...a) => apiSaveProgress(...a),
    simliToken: vi.fn(),
    simliIce: vi.fn(),
    tavusStart: vi.fn(),
    tavusEnd: vi.fn(),
    ask: vi.fn(),
  },
  getToken: () => null,
  setToken: () => {},
  fetchTtsAudio: (...a) => fetchTtsAudio(...a),
}));

// Mira and Daniel are both plain photo personas (no Simli/Tavus), but
// SimliAvatar.jsx / TavusAvatar.jsx still import these packages at module
// load time, so they must be mocked regardless (same pattern as
// changePresenter.test.js).
vi.mock('simli-client', () => ({ SimliClient: class {} }));
vi.mock('@daily-co/daily-js', () => ({ default: { createCallObject: vi.fn() } }));

// Deterministic, fully controllable stand-in for the Web Speech layer (same
// approach as listeningBadge.test.js) — lets the test drive onStart/
// onBoundary explicitly instead of depending on jsdom's absent
// speechSynthesis, and simulate narration being interrupted mid-utterance by
// simply never firing onEnd.
const speak = vi.fn();
vi.mock('../src/speech.js', () => ({
  speak: (...a) => speak(...a),
  cancelSpeech: vi.fn(),
  pickVoiceInfo: vi.fn(() => new Promise(() => {})),
  speechSupported: vi.fn(() => true),
  langTag: vi.fn(() => 'en-US'),
}));

const { CourseApp } = await import('../src/App.jsx');

const ui = {
  appName: 'Practical Scrum',
  tagline: 'Learn Scrum end to end, guided by Mira.',
  startCourse: 'Start course',
  resume: 'Resume',
  choosePresenter: 'Choose your presenter',
  changePresenter: 'Change presenter',
  selected: 'Selected',
  choose: 'Choose',
  moduleList: 'Modules',
  module: 'Module',
  estMin: 'min',
  raiseHand: 'Raise hand',
  questionTitle: 'You have a question?',
  raiseHandPrompt: '',
  type: 'Type',
  speak: 'Speak',
  play: 'Play',
  pause: 'Pause',
  prev: 'Previous segment',
  next: 'Next segment',
  ask: 'Ask',
  noMore: 'No more · resume',
  askPlaceholder: 'Ask about this topic…',
  captions: 'Captions',
  avatarLoading: 'Loading the presenter…',
  resumeAfterQuestion: '',
  continue: 'Continue',
  loading: 'Loading…',
  empty: 'Nothing here yet.',
  saved: 'Progress saved',
  errorGeneric: 'Something went wrong. Try again.',
  listening: 'Listening',
  speaking: 'Speaking',
  onTopicSource: 'source',
  holdToTalk: 'Mic is on.',
  voiceUnsupported: "Voice input isn't supported in this browser.",
  thinking: 'Thinking…',
  voiceReplies: 'Voice replies',
  voice: 'Voice',
  voiceUnavailable: 'No browser fallback voice found for this language.',
  lowCertainty: 'Not fully sure — feel free to rephrase',
  qaTitle: 'Q&A',
  askPrompt: 'Raise your hand and ask by text or voice.',
  knowledgeCheck: 'Knowledge check',
  logout: 'Log out',
};

const course = {
  title: 'Practical Scrum',
  supportedLanguages: ['en'],
  avatars: [
    { id: 'mira', name: 'Mira', role: 'Coach', desc: 'Warm and measured.' },
    { id: 'daniel', name: 'Daniel', role: 'Coach', desc: 'Lower, informative.' },
  ],
  modules: [
    { id: 'm1', title: 'Module 1', summary: 'Intro', estimatedMinutes: 5 },
  ],
};
// A {{presenter}} token segment (the "what-is-scrum"-shaped case the ticket
// calls out): Mira (4 chars) and Daniel (6 chars) substitute to different
// lengths, so a naive absolute-offset resume would land on the wrong
// character for the new presenter.
const testMod = {
  title: 'Module 1',
  segments: [{ text: '{{presenter}} explains Scrum today.', steps: [] }],
  check: null,
};

function renderApp() {
  return render(createElement(CourseApp, { user: { displayName: 'Learner' }, onLogout: vi.fn() }));
}

function permanentTtsFailure() {
  return Object.assign(new Error('tts unavailable'), { detail: 'TTS is not configured.' });
}

async function startCourseAsAvatar(name) {
  fireEvent.click(await screen.findByText(ui.startCourse));
  await screen.findByText(ui.choosePresenter);
  fireEvent.click(screen.getByText(name).closest('button'));
  fireEvent.click(screen.getByText(ui.continue));
  await screen.findByRole('heading', { name: ui.moduleList });
  fireEvent.click(screen.getByText('Module 1').closest('button'));
  await screen.findByText('Module 1');
}

function switchPresenterTo(name) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(ui.changePresenter) }));
  return screen.findByText(ui.choosePresenter).then(() => {
    fireEvent.click(screen.getByText(name).closest('button'));
    fireEvent.click(screen.getByText(ui.continue));
    return screen.findByText('Module 1');
  });
}

describe('Change presenter mid-segment resumes narration by TEXT POSITION, not from the top', () => {
  beforeEach(() => {
    speak.mockReset();
    apiCourse.mockReset().mockResolvedValue(course);
    apiUiStrings.mockReset().mockResolvedValue(ui);
    apiGetProgress.mockReset().mockResolvedValue(null);
    apiModule.mockReset().mockResolvedValue(testMod);
    apiSaveProgress.mockReset().mockResolvedValue({});
    fetchTtsAudio.mockReset().mockRejectedValue(permanentTtsFailure());
    ttsCircuit._resetForTests();
  });
  afterEach(() => { cleanup(); });

  it('resumes the new presenter from where the old one stopped, not from the top of the segment', async () => {
    renderApp();
    await startCourseAsAvatar('Mira');

    // First Play, cold start: speak() reports narration underway (onStart)
    // and progressed 6 characters in (onBoundary(6)) — then goes silent
    // without ever finishing (no onEnd), simulating an interruption.
    speak.mockImplementationOnce((text, lang, opts) => {
      opts.onStart();
      opts.onBoundary(6);
      return Promise.resolve(() => {});
    });
    fireEvent.click(screen.getByLabelText(ui.play));
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect(speak.mock.calls[0][0]).toBe('Mira explains Scrum today.');

    await switchPresenterTo('Daniel');

    speak.mockImplementationOnce((text, lang, opts) => {
      opts.onStart();
      return Promise.resolve(() => {});
    });
    fireEvent.click(screen.getByLabelText(ui.play));
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(2));

    // The tail of Daniel's substituted text starting at the position
    // equivalent to Mira's offset 6 — NOT Daniel's full segment text.
    expect(speak.mock.calls[1][0]).toBe('xplains Scrum today.');
    expect(speak.mock.calls[1][0]).not.toBe('Daniel explains Scrum today.');
  });

  it('a second Play on the same (new) presenter after finishing does not re-apply a stale offset', async () => {
    renderApp();
    await startCourseAsAvatar('Mira');

    // Play is never pressed on Mira — nothing has been narrated yet.
    await switchPresenterTo('Daniel');

    speak.mockImplementationOnce((text, lang, opts) => {
      opts.onStart();
      return Promise.resolve(() => {});
    });
    fireEvent.click(screen.getByLabelText(ui.play));
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(1));

    // offset=0 is the safe default: nothing was spoken before the switch.
    expect(speak.mock.calls[0][0]).toBe('Daniel explains Scrum today.');
  });
});
