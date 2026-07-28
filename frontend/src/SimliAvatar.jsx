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

const SimliAvatar = forwardRef(function SimliAvatar({ faceId, size = 150, onReady }, ref) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const clientRef = useRef(null);
  const settledRef = useRef(false); // onReady must fire exactly once per start()
  const timersRef = useRef([]);
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

  function teardown() {
    clearTimers();
    if (clientRef.current) {
      try { clientRef.current.stop(); } catch { /* already gone */ }
      clientRef.current = null;
    }
  }

  useEffect(() => teardown, []);

  useImperativeHandle(ref, () => ({
    // audioEl: the <audio> element playing our narration. Simli reads its
    // samples for lip-sync and relays the voice back on its own audio track.
    async start(audioEl) {
      if (clientRef.current) return;
      settledRef.current = false;
      setStatus('connecting');
      setError('');
      try {
        const { session_token: sessionToken } = await api.simliToken(faceId);

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

        // Belt and braces: go live on the first real frame even if 'start'
        // never fires, and give up cleanly if nothing arrives at all — the
        // parent then falls back rather than showing a black rectangle.
        const vid = videoRef.current;
        const poll = setInterval(() => {
          if (vid && vid.videoWidth > 0 && vid.readyState >= 2) settle(true);
        }, 250);
        const giveUp = setTimeout(
          () => settle(false, 'No video from the avatar service — the network may be blocking it.'),
          CONNECT_TIMEOUT_MS,
        );
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

  return (
    <div className="simli-avatar" style={{ width: size, height: size * 1.15 }}>
      <video ref={videoRef} autoPlay playsInline muted={false} />
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
