import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
} from 'react';
import { SimliClient } from 'simli-client';
import { api } from './api.js';

// Live, WebRTC video avatar via Simli — a real moving face with actual lip-sync,
// as opposed to the CSS mouth-overlay used on the static photo avatars.
//
// Fully externally controlled: this component owns no button and grabs no
// media itself. The caller (Classroom) captures a MediaStreamTrack of the
// tab's own audio output (so it picks up whatever the Web Speech API plays —
// narration, prompts, Q&A answers, all in one place) and calls
// start(track, faceId) via the ref once. A Simli connection with no audio
// track at all just goes idle and eventually blacks out, which is why this
// is only ever mounted once a real track is available — see Classroom's
// ensureLiveAvatar / liveNarration.
const SimliAvatar = forwardRef(function SimliAvatar({ size = 170, onStatusChange }, ref) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const clientRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | connecting | live | error
  const [error, setError] = useState('');

  useEffect(() => () => {
    if (clientRef.current) { clientRef.current.stop(); clientRef.current = null; }
  }, []);

  useEffect(() => {
    if (onStatusChange) onStatusChange(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

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
