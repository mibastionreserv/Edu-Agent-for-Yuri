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
  const frameWatchRef = useRef(null);
  const cleanupVideoListenersRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | connecting | live | error
  const [error, setError] = useState('');

  useEffect(() => () => {
    if (frameWatchRef.current) { clearInterval(frameWatchRef.current); frameWatchRef.current = null; }
    if (cleanupVideoListenersRef.current) { cleanupVideoListenersRef.current(); cleanupVideoListenersRef.current = null; }
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
        // Token and ICE fetches are independent — running them in parallel
        // shaves ~1s off every connect (they used to run sequentially).
        const [{ session_token: sessionToken }, iceServers] = await Promise.all([
          api.simliToken(faceId),
          api.simliIce().then((r) => r.iceServers).catch(() => null),
        ]);
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

        // Ground truth is PIXELS ON SCREEN, not the SDK's 'start' event —
        // observed on production: real video frames were flowing (512x512,
        // readyState 4, currentTime advancing) while 'start' never fired, so
        // the opaque "Connecting…" overlay stayed up and hid the avatar
        // completely. Watch the element itself and go live the moment it has
        // actual dimensions.
        const vid = videoRef.current;
        if (vid) {
          const markLive = () => { if (vid.videoWidth > 0) setStatus('live'); };
          vid.addEventListener('loadeddata', markLive);
          vid.addEventListener('playing', markLive);
          vid.addEventListener('resize', markLive);
          let waited = 0;
          frameWatchRef.current = setInterval(() => {
            waited += 250;
            if (vid.videoWidth > 0 && vid.readyState >= 2) {
              setStatus('live');
              clearInterval(frameWatchRef.current);
              frameWatchRef.current = null;
            } else if (waited >= 15000) {
              // No frames after 15s means the media path never came up
              // (commonly a network that permits the signalling handshake
              // but blocks the WebRTC media itself). Report failure so the
              // caller can show the photo presenter — a black rectangle is
              // the one outcome that is worse than not using video at all.
              setStatus('error');
              setError('Live video could not be established.');
              clearInterval(frameWatchRef.current);
              frameWatchRef.current = null;
            }
          }, 250);
          cleanupVideoListenersRef.current = () => {
            vid.removeEventListener('loadeddata', markLive);
            vid.removeEventListener('playing', markLive);
            vid.removeEventListener('resize', markLive);
          };
        }

        await client.start();
        if (track) client.listenToMediastreamTrack(track);
        clientRef.current = client;
      } catch (e) {
        setStatus('error');
        setError((e && e.message) || 'Could not start the live avatar.');
      }
    },
    stop() {
      if (frameWatchRef.current) { clearInterval(frameWatchRef.current); frameWatchRef.current = null; }
      if (cleanupVideoListenersRef.current) { cleanupVideoListenersRef.current(); cleanupVideoListenersRef.current = null; }
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
