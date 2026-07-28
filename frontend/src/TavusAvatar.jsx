import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
} from 'react';
import Daily from '@daily-co/daily-js';
import { api } from './api.js';

// Live, WebRTC video avatar via Tavus's Conversational Video Interface (CVI),
// used in "echo" mode: Amara's persona on Tavus is pre-configured to bypass
// perception/STT/LLM entirely, so all we ever do is (1) join the Daily.co
// room Tavus hands back for a conversation and (2) broadcast narration text
// as a conversation.echo app-message over that call's data channel. Tavus's
// own TTS engine and Phoenix face-rendering engine handle voice synthesis and
// lip-synced video entirely server-side — unlike Simli, there's no local
// audio-capture step at all: Tavus IS the audio source, so the whole
// speak-and-lip-sync problem is theirs to solve, not ours.
const TavusAvatar = forwardRef(function TavusAvatar({ size = 170, onStatusChange, onStoppedSpeaking }, ref) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const callRef = useRef(null);
  const conversationIdRef = useRef(null);
  const onStoppedSpeakingRef = useRef(onStoppedSpeaking);
  onStoppedSpeakingRef.current = onStoppedSpeaking;
  const [status, setStatus] = useState('idle'); // idle | connecting | live | error
  const [error, setError] = useState('');

  function teardown() {
    if (callRef.current) {
      try { callRef.current.leave(); } catch { /* noop */ }
      try { callRef.current.destroy(); } catch { /* noop */ }
      callRef.current = null;
    }
    if (conversationIdRef.current) {
      api.tavusEnd(conversationIdRef.current).catch(() => {});
      conversationIdRef.current = null;
    }
  }

  useEffect(() => teardown, []);

  useEffect(() => {
    if (onStatusChange) onStatusChange(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useImperativeHandle(ref, () => ({
    // Creates a Tavus conversation and joins its Daily room. Resolves with
    // the conversation_id once actually connected (or null on failure) — the
    // caller awaits this before sending the first line, since Tavus is the
    // only source of audio for this persona (no local fallback playing in
    // the meantime, unlike Simli).
    async start() {
      setStatus('connecting');
      setError('');
      try {
        const { conversationId, conversationUrl } = await api.tavusStart();
        conversationIdRef.current = conversationId;
        // We never send our own mic/camera — Tavus is the only audio/video
        // source in echo mode. Without disabling these, Daily's default call
        // object tries to acquire local mic+camera via getUserMedia() before
        // it will join, and if that permission prompt is never answered (or
        // is blocked), join() hangs forever and the avatar never appears —
        // this was the root cause of Amara's live avatar never showing up.
        const call = Daily.createCallObject({
          url: conversationUrl,
          audioSource: false,
          videoSource: false,
        });
        // Set eagerly (not after join resolves) so teardown() can always
        // reach this call object, including when join() below times out —
        // otherwise a timed-out call keeps trying to connect in the
        // background with nothing left able to leave/destroy it.
        callRef.current = call;
        call.on('track-started', (ev) => {
          if (!ev || (ev.participant && ev.participant.local)) return;
          const stream = new MediaStream([ev.track]);
          if (ev.type === 'video' && videoRef.current) videoRef.current.srcObject = stream;
          if (ev.type === 'audio' && audioRef.current) audioRef.current.srcObject = stream;
        });
        call.on('joined-meeting', () => setStatus('live'));
        call.on('error', (e) => { setStatus('error'); setError((e && e.errorMsg) || 'Connection lost.'); });
        call.on('app-message', ({ data }) => {
          if (!data || data.conversation_id !== conversationId) return;
          const role = data.properties && data.properties.role;
          const isPalTurn = role === 'pal' || role === 'replica';
          if (data.event_type === 'conversation.stopped_speaking' && isPalTurn && onStoppedSpeakingRef.current) {
            onStoppedSpeakingRef.current();
          }
        });
        // A hard cap so a stuck join() (network/ICE issues) falls back to
        // Web Speech instead of leaving the full-screen loading overlay (see
        // App.jsx's avatarConnecting gate) stuck forever.
        await Promise.race([
          call.join(),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timed out connecting to the live avatar.')), 15000);
          }),
        ]);
        return conversationId;
      } catch (e) {
        setStatus('error');
        setError((e && e.message) || 'Could not start the live avatar.');
        teardown();
        return null;
      }
    },
    // Broadcasts text for the PAL to speak directly (bypasses Tavus's
    // perception/STT/LLM layers entirely, per the persona's echo mode).
    sendText(text) {
      const call = callRef.current;
      const conversationId = conversationIdRef.current;
      if (!call || !conversationId) return;
      call.sendAppMessage({
        message_type: 'conversation',
        event_type: 'conversation.echo',
        conversation_id: conversationId,
        properties: { modality: 'text', text, done: true },
      });
    },
    // Stops the PAL mid-utterance (pause / raise hand) without tearing down
    // the call — the conversation stays open so the next line is instant.
    interrupt() {
      const call = callRef.current;
      const conversationId = conversationIdRef.current;
      if (!call || !conversationId) return;
      call.sendAppMessage({
        message_type: 'conversation',
        event_type: 'conversation.interrupt',
        conversation_id: conversationId,
      });
    },
    stop() {
      teardown();
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

export default TavusAvatar;
