import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { render, cleanup } from '@testing-library/react';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const tavusStartDeferred = deferred();
const joinDeferred = deferred();

const tavusStart = vi.fn(() => tavusStartDeferred.promise);
const tavusEnd = vi.fn(() => Promise.resolve());

vi.mock('../src/api.js', () => ({
  api: { tavusStart: (...a) => tavusStart(...a), tavusEnd: (...a) => tavusEnd(...a) },
}));

function makeFakeCall() {
  return {
    on: vi.fn(),
    join: vi.fn(() => joinDeferred.promise),
    leave: vi.fn(),
    destroy: vi.fn(),
    sendAppMessage: vi.fn(),
  };
}

const fakeCall = makeFakeCall();
const createCallObject = vi.fn(() => fakeCall);

vi.mock('@daily-co/daily-js', () => ({
  default: { createCallObject: (...a) => createCallObject(...a) },
}));

const { default: TavusAvatar } = await import('../src/TavusAvatar.jsx');
const { createElement } = await import('react');

// SS-28: unmounting the presenter dock (e.g. the learner switches module/
// language) while start() is still awaiting an async step must not let a
// stale connection keep initializing behind the component's back — this is
// the Tavus-side repeat of the unmount/await race fixed for Simli by SS-9.
describe('TavusAvatar unmount guard (SS-28)', () => {
  it('never creates a Daily call object if unmounted while api.tavusStart() is still pending', async () => {
    const ref = createRef();
    const { unmount } = render(createElement(TavusAvatar, { ref }));

    const startPromise = ref.current.start();
    unmount();

    tavusStartDeferred.resolve({ conversationId: 'conv-1', conversationUrl: 'https://example.test/room' });
    const result = await startPromise;

    expect(result).toBeNull();
    expect(createCallObject).not.toHaveBeenCalled();

    cleanup();
  });

  it('tears down (leave/destroy) instead of returning a live conversation if unmounted while call.join() is pending', async () => {
    const ref = createRef();
    const { unmount } = render(createElement(TavusAvatar, { ref }));

    tavusStart.mockImplementationOnce(() => Promise.resolve({ conversationId: 'conv-2', conversationUrl: 'https://example.test/room-2' }));
    const startPromise = ref.current.start();

    // Flush microtasks so start() runs past the tavusStart() await and
    // reaches call.join() (which is left pending on joinDeferred) before we
    // unmount — this reproduces "unmount happens during the long join()".
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeCall.join).toHaveBeenCalledTimes(1);

    unmount();
    joinDeferred.resolve();
    const result = await startPromise;

    expect(result).toBeNull();
    expect(fakeCall.leave).toHaveBeenCalled();
    expect(fakeCall.destroy).toHaveBeenCalled();

    cleanup();
  });
});
