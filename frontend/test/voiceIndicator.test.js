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
  // ttsCircuit.js — it never opens the circuit (SS-12), so a line can fall
  // back to the browser voice without `ttsDown` ever becoming true.
  const e = new Error('tts failed 500');
  e.status = 500;
  e.detail = '';
  return e;
}

const apiModule = vi.fn();
const fetchTtsAudio = vi.fn();

vi.mock('../src/api.js', () => ({
  api: {
    module: (...a) => apiModule(...a),
    ask: vi.fn(),
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

// pickVoiceInfo never resolves in this suite, reproducing "the browser voice
// is still resolving" for as long as each test needs it.
vi.mock('../src/speech.js', () => ({
  speak: vi.fn((text, lang, opts) => { opts.onStart(); return Promise.resolve(() => {}); }),
  cancelSpeech: vi.fn(),
  pickVoiceInfo: vi.fn(() => new Promise(() => {})),
  speechSupported: vi.fn(() => true),
  langTag: vi.fn(() => 'en-US'),
}));

const { Classroom } = await import('../src/App.jsx');

const ui = { ask: 'Ask', askPlaceholder: 'Ask a question', voice: 'Voice' };
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

// This iteration's ticket: a single line (narration or a Q&A answer) can
// fall back to the browser voice WITHOUT the ttsCircuit ever opening — a
// transient failure (5xx/no-audio/network blip) never trips it (SS-12) — so
// `ttsDown` alone was not enough to know the persona's server voice label
// was still accurate. Once the browser voice has genuinely started, the
// indicator must stop naming the server persona voice (e.g. "Gacrux") even
// while it's still resolving which browser voice is actually speaking.
describe('voice indicator never names the server persona voice once the browser fallback is actually speaking', () => {
  beforeEach(() => {
    apiModule.mockReset();
    apiModule.mockResolvedValue(testMod);
    fetchTtsAudio.mockReset();
    fetchTtsAudio.mockRejectedValue(transientErr());
    ttsCircuit._resetForTests();
  });
  afterEach(() => { cleanup(); });

  it('shows the server persona voice before playback, then "…" (not the server voice) once Web Speech has actually started', async () => {
    const { container } = renderClassroom();
    const playButton = await screen.findByText('▶');
    const voiceLabel = () => container.querySelector('.voicename')?.textContent || '';

    expect(voiceLabel()).toMatch(/Gacrux/);

    await act(async () => {
      fireEvent.click(playButton);
      // speakViaServerTts retries once, 800ms later, before falling through
      // to the browser voice — both attempts reject transiently here.
      await new Promise((r) => { setTimeout(r, 900); });
    });

    expect(voiceLabel()).not.toMatch(/Gacrux/);
    expect(voiceLabel()).toMatch(/Voice: …/);
  });
});
