import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import * as ttsCircuit from '../src/ttsCircuit.js';

function rateLimitErr() {
  const e = new Error('tts failed 502 TTS 429');
  e.status = 502;
  e.detail = 'TTS 429';
  return e;
}
function sessionExpiredErr() {
  // Our OWN 401 (expired 12h session) — requireAuth's response has no
  // `detail` field at all, unlike a real upstream TTS failure.
  const e = new Error('tts failed 401');
  e.status = 401;
  e.detail = '';
  return e;
}
function permanentErr(detail) {
  const e = new Error(`tts failed 502 ${detail}`);
  e.status = 502;
  e.detail = detail;
  return e;
}
function transientErr() {
  const e = new Error('tts failed 500');
  e.status = 500;
  e.detail = '';
  return e;
}

describe('ttsCircuit (SS-20)', () => {
  beforeEach(() => {
    ttsCircuit._resetForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts closed', () => {
    expect(ttsCircuit.canAttempt()).toBe(true);
    expect(ttsCircuit.state().status).toBe('closed');
  });

  it('a 429 opens the circuit with a bounded backoff, not forever', () => {
    const kind = ttsCircuit.recordFailure(rateLimitErr());
    expect(kind).toBe('rate-limit');
    expect(ttsCircuit.canAttempt()).toBe(false);
    expect(ttsCircuit.state().status).toBe('open');

    // Still closed short of the cooldown.
    vi.advanceTimersByTime(44_000);
    expect(ttsCircuit.canAttempt()).toBe(false);

    // Past the cooldown: exactly one half-open probe is granted...
    vi.advanceTimersByTime(2_000);
    expect(ttsCircuit.canAttempt()).toBe(true);
    // ...and NOT a second one before the first resolves.
    expect(ttsCircuit.canAttempt()).toBe(false);
  });

  it('escalates the backoff on repeated 429s and resets it on success', () => {
    ttsCircuit.recordFailure(rateLimitErr());
    vi.advanceTimersByTime(45_000);
    expect(ttsCircuit.canAttempt()).toBe(true); // 1st probe granted
    ttsCircuit.recordFailure(rateLimitErr()); // probe itself hit another 429
    vi.advanceTimersByTime(45_000);
    expect(ttsCircuit.canAttempt()).toBe(false); // backoff #2 (90s) not elapsed yet
    vi.advanceTimersByTime(45_001);
    expect(ttsCircuit.canAttempt()).toBe(true); // 90s total has now elapsed

    ttsCircuit.recordSuccess();
    expect(ttsCircuit.state().consecutiveFailures).toBe(0);
    expect(ttsCircuit.canAttempt()).toBe(true);
  });

  it('caps the backoff instead of growing unboundedly', () => {
    for (let i = 0; i < 10; i += 1) {
      ttsCircuit.recordFailure(rateLimitErr());
      vi.advanceTimersByTime(700_000); // more than the largest step (600s)
    }
    expect(ttsCircuit.canAttempt()).toBe(true);
  });

  it('a real upstream 401/403 latches the circuit for the whole session (no timer clears it)', () => {
    const kind = ttsCircuit.recordFailure(permanentErr('TTS 401'));
    expect(kind).toBe('permanent');
    expect(ttsCircuit.canAttempt()).toBe(false);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(ttsCircuit.canAttempt()).toBe(false);
    expect(ttsCircuit.state().permanent).toBe(true);
  });

  it('"TTS is not configured." latches permanently too', () => {
    ttsCircuit.recordFailure(permanentErr('TTS is not configured.'));
    expect(ttsCircuit.canAttempt()).toBe(false);
    expect(ttsCircuit.state().permanent).toBe(true);
  });

  // The regression this whole ticket is about: our own expired-session 401
  // (no `detail` field — only the upstream provider's is shaped like
  // "TTS 401") must never be classified as a permanent TTS failure.
  it('does not confuse our own expired-session 401 with an upstream TTS 401', () => {
    const kind = ttsCircuit.recordFailure(sessionExpiredErr());
    expect(kind).toBe('transient');
    expect(ttsCircuit.canAttempt()).toBe(true);
    expect(ttsCircuit.state().status).toBe('closed');
  });

  // Carried over from SS-12: a one-off flake must never latch the whole
  // session onto the fallback voice.
  it('transient errors (5xx/network) never open the circuit', () => {
    ttsCircuit.recordFailure(transientErr());
    expect(ttsCircuit.canAttempt()).toBe(true);
    expect(ttsCircuit.state().status).toBe('closed');
  });

  it('success resets the circuit back to closed and clears the indicator state', () => {
    ttsCircuit.recordFailure(rateLimitErr());
    expect(ttsCircuit.canAttempt()).toBe(false);
    vi.advanceTimersByTime(45_000);
    expect(ttsCircuit.canAttempt()).toBe(true); // half-open probe
    ttsCircuit.recordSuccess();
    expect(ttsCircuit.state().status).toBe('closed');
    expect(ttsCircuit.canAttempt()).toBe(true);
  });

  it('an abandoned half-open probe does not wedge the circuit open forever', () => {
    ttsCircuit.recordFailure(rateLimitErr());
    vi.advanceTimersByTime(45_000);
    expect(ttsCircuit.canAttempt()).toBe(true); // probe granted, never resolved
    expect(ttsCircuit.canAttempt()).toBe(false); // no second probe meanwhile
    vi.advanceTimersByTime(36_000); // past the probe timeout
    expect(ttsCircuit.canAttempt()).toBe(false); // falls back to a fresh cooldown...
    vi.advanceTimersByTime(90_000); // ...which eventually elapses again
    expect(ttsCircuit.canAttempt()).toBe(true);
  });
});
