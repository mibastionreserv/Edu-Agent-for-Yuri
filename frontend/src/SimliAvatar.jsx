import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
} from 'react';
import { SimliClient } from 'simli-client';
import { api } from './api.js';

// Live video avatar via Simli (app.simli.com). Rewritten from scratch after
// the incremental version accumulated workarounds that hid two real defects:
//
//  1. It forced transport_mode 'p2p' — a direct browser↔Simli media
//     connection. That works on permissive networks and silently yields a
//     black frame wherever direct media is blocked (corporate networks,
//     some ISPs/VPNs, strict firewalls): the signalling handshake succeeds,
//     so everything *looks* connected, but no video ever arrives. We now use
//     'livekit', which relays media through an SFU with TURN fallback and
//     traverses restrictive networks.
//
//  2. It hand-rolled a Web Audio graph (createMediaElementSource →
//     MediaStreamDestination → listenToMediastreamTrack) to feed narration
//     audio to Simli. The SDK ships listenToAudioElement() which does
//     exactly that, correctly, including muting the local element so the
//     learner never hears the line twice.
//
// Contract: the parent renders a hidden <audio> element carrying our
// server-synthesized narration and calls start(audioElement). Readiness is
// reported through onReady(true|false) — resolved from the SDK's 'start'
// event OR the first real video frame, whichever lands first, because the
// 'start' event has been observed not to fire even when frames are flowing.
const CONNECT_TIMEOUT_MS = 20000;

const SimliAvatar = forwardRef(function SimliAvatar({
  faceId, size = 150, onReady, posterSrc,
}, ref) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const clientRef = useRef(null);
  const settledRef = useRef(false); // onReady must fire exactly once per start()
  const timersRef = useRef([]);
  const unmountedRef = useRef(false);
  const [status, setStatus] = useState('idle'); // idle | connecting | live | error
  const [error, setError] = useState('');

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  function clearTimers() {
    timersRef.current.forEach((t) => clearInterval(t) || clearTimeout(t));
    timersRef.current = [];
  }

  function settle(ok, message) {
    if (settledRef.current) return;
    settledRef.current = true;
    clearTimers();
    if (ok) {
      setStatus('live');
    } else {
      setStatus('error');
      setError(message || 'The live avatar could not be reached.');
    }
    if (onReadyRef.current) onReadyRef.current(ok);
  }

  // Undoes listenToAudioElement()'s Web Audio graph: the SDK's own stop()
  // only tears down the transport, so a torn-down-but-not-disconnected
  // AudioWorkletNode keeps posting buffers into a closed WS forever.
  async function disconnectAudioGraph(client) {
    try {
      if (client.audioWorklet) {
        client.audioWorklet.port.onmessage = null;
        client.audioWorklet.disconnect();
      }
    } catch { /* already gone */ }
    try { client.sourceNode?.disconnect(); } catch { /* already gone */ }
    try { await client.audioContext?.close(); } catch { /* already gone */ }
  }

  function teardown() {
    clearTimers();
    if (clientRef.current) {
      const client = clientRef.current;
      clientRef.current = null;
      disconnectAudioGraph(client).finally(() => {
        try { client.stop(); } catch { /* already gone */ }
      });
    }
  }

  useEffect(() => () => {
    unmountedRef.current = true;
    teardown();
  }, []);

  useImperativeHandle(ref, () => ({
    // audioEl: the <audio> element playing our narration. Simli reads its
    // samples for lip-sync and relays the voice back on its own audio track.
    async start(audioEl) {
      if (clientRef.current) return;
      settledRef.current = false;
      unmountedRef.current = false;
      setStatus('connecting');
      setError('');
      try {
        const { session_token: sessionToken } = await api.simliToken(faceId);

        // The component may have unmounted while the token request was in
        // flight. SimliClient only opens a connection inside start(), so as
        // long as we bail before constructing it, nothing needs tearing
        // down — this is what stops an orphaned live session from forming.
        if (unmountedRef.current) return;

        const client = new SimliClient(
          sessionToken,
          videoRef.current,
          audioRef.current,
          null, // LiveKit negotiates its own ICE/TURN servers
          undefined, // default log level
          'livekit',
        );
        clientRef.current = client;

        client.on('start', () => settle(true));
        client.on('error', (detail) => settle(false, String(detail || 'Connection lost.')));
        client.on('startup_error', (msg) => settle(false, String(msg || 'Could not start.')));

        await client.start();

        // Feed narration audio in with the SDK's own helper (it mutes local
        // playback for us, so the voice is heard once, via Simli).
        if (audioEl) client.listenToAudioElement(audioEl);

        // Go live on the first real frame even if 'start' never fires. The
        // poll keeps running past the timeout: reporting "not ready" only
        // unblocks the lesson (the poster is shown meanwhile) — it must not
        // stop a stream that is merely slow from appearing when it lands.
        const vid = videoRef.current;
        const poll = setInterval(() => {
          if (vid && vid.videoWidth > 0 && vid.readyState >= 2) {
            settledRef.current = false; // allow the late success to register
            settle(true);
          }
        }, 250);
        const giveUp = setTimeout(() => {
          if (!settledRef.current) {
            // Report failure so narration proceeds without waiting, but keep
            // the connection and the poll alive.
            settledRef.current = true;
            if (onReadyRef.current) onReadyRef.current(false);
          }
        }, CONNECT_TIMEOUT_MS);
        timersRef.current.push(poll, giveUp);
      } catch (e) {
        settle(false, (e && e.message) || 'Could not start the live avatar.');
        teardown();
      }
    },
    stop() {
      teardown();
      settledRef.current = false;
      setStatus('idle');
    },
  }));

  // The poster (persona photo) sits UNDER the video and is simply covered
  // once real frames arrive. This is why the component never unmounts on
  // failure: tearing it down would destroy a connection that may still be
  // completing, and a late-arriving stream would have nowhere to appear.
  // The learner sees the presenter either way — never a black rectangle.
  return (
    <div className="simli-avatar" style={{ width: size, height: size * 1.15 }}>
      {posterSrc && status !== 'live' && (
        <img className="simli-poster" src={posterSrc} alt="" aria-hidden="true" />
      )}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={false}
        style={{ opacity: status === 'live' ? 1 : 0 }}
      />
      <audio ref={audioRef} autoPlay />
      {status === 'connecting' && (
        <div className="simli-overlay"><span className="simli-hint">Connecting…</span></div>
      )}
      {status === 'error' && (
        <div className="simli-overlay"><span className="simli-hint err">{error}</span></div>
      )}
    </div>
  );
});

export default SimliAvatar;
