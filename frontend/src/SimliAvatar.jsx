import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
} from 'react';
import { SimliClient } from 'simli-client';
import { api } from './api.js';

// Live, WebRTC video avatar via Simli — a real moving face with actual lip-sync,
// as opposed to the CSS mouth-overlay used on the static photo avatars.
//
// Fully externally controlled: this component owns no button and never grabs
// the microphone itself. The caller (Classroom) grabs a MediaStreamTrack —
// only while the learner is actively asking a voice question — and calls
// start(track, faceId) / stop() via the ref. That's the deliberate scope
// limit: Simli needs a real audio stream to drive lip-sync, and the app's
// lesson narration plays through the browser's Web Speech API, which never
// exposes raw audio — so this can't (yet) lip-sync to the lesson itself.
const SimliAvatar = forwardRef(function SimliAvatar({ size = 170 }, ref) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const clientRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | connecting | live | error
  const [error, setError] = useState('');

  useEffect(() => () => {
    if (clientRef.current) { clientRef.current.stop(); clientRef.current = null; }
  }, []);

  useImperativeHandle(ref, () => ({
    async start(track, faceId) {
      setStatus('connecting');
      setError('');
      try {
        const { session_token: sessionToken } = await api.simliToken(faceId);
        const iceServers = await api.simliIce().then((r) => r.iceServers).catch(() => null);
        const client = new SimliClient(
          sessionToken,
          videoRef.current,
          audioRef.current,
          iceServers || null,
          undefined,
          'p2p',
        );
        client.on('start', () => setStatus('live'));
        client.on('error', () => { setStatus('error'); setError('Connection lost.'); });
        client.on('startup_error', (msg) => { setStatus('error'); setError(String(msg || 'Could not start.')); });
        await client.start();
        if (track) client.listenToMediastreamTrack(track);
        clientRef.current = client;
      } catch (e) {
        setStatus('error');
        setError((e && e.message) || 'Could not start the live avatar.');
      }
    },
    stop() {
      if (clientRef.current) { clientRef.current.stop(); clientRef.current = null; }
      setStatus('idle');
    },
  }));

  const dims = { width: size, height: size * 1.15 };

  return (
    <div className="simli-avatar" style={dims}>
      <video ref={videoRef} autoPlay playsInline />
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
