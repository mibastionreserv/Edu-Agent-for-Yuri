import { useEffect, useRef, useState } from 'react';
import { SimliClient } from 'simli-client';
import { api } from './api.js';

// Live, WebRTC video avatar via Simli — a real moving face with actual lip-sync,
// as opposed to the CSS mouth-overlay used on the static photo avatars.
//
// Important limitation (by design, for now): Simli needs a real audio stream to
// drive lip-sync. The app's narration/Q&A speech currently plays through the
// browser's built-in Web Speech API, which never exposes raw audio bytes to
// JS — so it can't be piped to Simli yet. Until the speech pipeline moves to a
// server-side/streamable TTS, this component lip-syncs to the LEARNER'S OWN
// microphone rather than to the course narration. That's why it's an opt-in
// "Connect & talk" demo rather than something that auto-speaks the lesson.
export default function SimliAvatar({ faceId, size = 170 }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const clientRef = useRef(null);
  const micStreamRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | connecting | live | error
  const [error, setError] = useState('');

  useEffect(() => () => {
    if (clientRef.current) { clientRef.current.stop(); clientRef.current = null; }
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach((t) => t.stop()); micStreamRef.current = null; }
  }, []);

  async function connect() {
    setStatus('connecting');
    setError('');
    try {
      const { session_token: sessionToken } = await api.simliToken(faceId);
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = mic;

      const client = new SimliClient(
        sessionToken,
        videoRef.current,
        audioRef.current,
        null,
        undefined,
        'livekit',
      );
      client.on('start', () => setStatus('live'));
      client.on('error', () => { setStatus('error'); setError('Connection lost.'); });
      client.on('startup_error', (msg) => { setStatus('error'); setError(String(msg || 'Could not start.')); });
      await client.start();
      client.listenToMediastreamTrack(mic.getAudioTracks()[0]);
      clientRef.current = client;
    } catch (e) {
      setStatus('error');
      setError((e && e.message) || 'Could not start the live avatar.');
      if (micStreamRef.current) { micStreamRef.current.getTracks().forEach((t) => t.stop()); micStreamRef.current = null; }
    }
  }

  function disconnect() {
    if (clientRef.current) { clientRef.current.stop(); clientRef.current = null; }
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach((t) => t.stop()); micStreamRef.current = null; }
    setStatus('idle');
  }

  const dims = { width: size, height: size * 1.15 };

  return (
    <div className="simli-avatar" style={dims}>
      <video ref={videoRef} autoPlay playsInline muted={false} />
      <audio ref={audioRef} autoPlay />
      {status !== 'live' && (
        <div className="simli-overlay">
          {status === 'idle' && <button className="simli-btn" onClick={connect} type="button">Connect &amp; talk</button>}
          {status === 'connecting' && <span className="simli-hint">Connecting…</span>}
          {status === 'error' && (
            <>
              <span className="simli-hint err">{error}</span>
              <button className="simli-btn" onClick={connect} type="button">Retry</button>
            </>
          )}
        </div>
      )}
      {status === 'live' && (
        <button className="simli-btn simli-btn-stop" onClick={disconnect} type="button">Disconnect</button>
      )}
    </div>
  );
}
