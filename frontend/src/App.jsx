import React, {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { api, getToken, setToken, fetchTtsAudio } from './api.js';
import { avatarSVG } from './avatar.js';
import SimliAvatar from './SimliAvatar.jsx';
import TavusAvatar from './TavusAvatar.jsx';
import Board from './Board.jsx';
import KnowledgeCheck from './KnowledgeCheck.jsx';
import {
  speak, cancelSpeech, pickVoiceName, speechSupported, langTag,
} from './speech.js';

const COURSE_ID = 'practical-scrum';

/* ---------------- small UI atoms ---------------- */
function Spinner({ label }) {
  return <div className="state"><span className="spin" aria-hidden="true" /> {label}</div>;
}
function ErrorBanner({ msg, onRetry, retryLabel }) {
  if (!msg) return null;
  return (
    <div className="banner err" role="alert">
      <span>{msg}</span>
      {onRetry && <button className="link" onClick={onRetry}>{retryLabel || 'Retry'}</button>}
    </div>
  );
}
function Toast({ msg }) {
  if (!msg) return null;
  return <div className="toast" role="status">{msg}</div>;
}
// Mouth position (% of the displayed avatar box, already corrected for the
// object-fit:cover crop) for each photo avatar. Measured once per photo with
// a face-landmark pass; add an entry here when a new photo is dropped in
// course-content/avatars/ to get a talking-mouth overlay on it too.
const PHOTO_LANDMARKS = {
  mira: { mouthX: 50, mouthY: 47 },
  meilin: { mouthX: 50, mouthY: 56 },
};

// Personas backed by a live Simli video avatar (real WebRTC face + lip-sync)
// instead of a static photo. Maps our avatar id -> Simli faceId.
const SIMLI_FACES = {
  meilin: '121cd5ae-7df7-4ea3-a389-401a9463db52', // "Edna" preset face
};

// Personas backed by a live Tavus video avatar instead. Tavus's PAL for
// Amara is pre-configured server-side in "echo" pipeline mode (see
// backend/src/tavus.js) — Tavus's own TTS + Phoenix engine handle voice
// synthesis and lip-synced rendering, so there's no local audio pipeline for
// this persona at all, unlike Simli/Mei-Lin.
const TAVUS_PERSONAS = { amara: true };

function Avatar({ id, mouth, state, size = 180 }) {
  // Content-driven photo avatars: drop course-content/avatars/<id>.jpg and it
  // replaces the drawn SVG automatically, no code change needed per persona.
  // Used on the picker page for everyone, and in the classroom ONLY for
  // personas without a live-avatar provider. Live-avatar personas
  // (SIMLI_FACES / TAVUS_PERSONAS) never show this in the classroom — the
  // service-rendered video, connected as soon as the classroom opens, is the
  // only presenter rendering there (SRS FR-AV-5: no static stand-ins, no CSS
  // pseudo-animation).
  const [photoFailed, setPhotoFailed] = useState(false);
  const dims = { width: size, height: size * 1.15 };
  const lm = PHOTO_LANDMARKS[id];

  if (!photoFailed) {
    return (
      <div
        className={`avatar-photo ${state === 'listening' ? 'listening' : ''} ${mouth ? 'speaking' : ''}`}
        style={dims}
      >
        <img
          src={`/content/avatars/${id}.jpg`}
          alt={id}
          onError={() => setPhotoFailed(true)}
        />
        {lm && (
          <span
            className={`ap-mouth ${mouth ? 'open' : ''}`}
            style={{ left: `${lm.mouthX}%`, top: `${lm.mouthY}%` }}
            aria-hidden="true"
          />
        )}
      </div>
    );
  }
  return (
    <div className="avatar-svg" style={dims}
      dangerouslySetInnerHTML={{ __html: avatarSVG(id, { mouth, state, k: `${id}${size}` }) }} />
  );
}

// number of board steps revealed given how far narration has progressed
function revealedFromProgress(charIndex, textLen, nSteps) {
  if (nSteps <= 0) return 0;
  if (textLen <= 0) return nSteps;
  let n = 1; // step 0 shows immediately on play
  for (let i = 1; i < nSteps; i += 1) {
    if (charIndex >= (i / nSteps) * textLen) n = i + 1;
  }
  return Math.min(n, nSteps);
}

/* ---------------- classroom ---------------- */
function Classroom({
  ui, lang, avatarId, course, moduleId, initialSegment, onExit, onSaved,
}) {
  const [mod, setMod] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const presenterName = (course.avatars || []).find((a) => a.id === avatarId)?.name || avatarId;
  const [seg, setSeg] = useState(initialSegment || 0);
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [mouth, setMouth] = useState(false);
  const [revealed, setRevealed] = useState(0);
  const [handUp, setHandUp] = useState(false);
  const [thread, setThread] = useState([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceReplies, setVoiceReplies] = useState(true);
  // Off by default per SRS §UI — captions are opt-in via the caption chip,
  // not shown automatically.
  const [captionsOn, setCaptionsOn] = useState(false);
  const [showCheck, setShowCheck] = useState(false);
  const [voiceName, setVoiceName] = useState('');
  const [paused, setPaused] = useState(false);
  const [simliFailed, setSimliFailed] = useState(false);
  const [liveNarration, setLiveNarration] = useState(false);
  const [tavusFailed, setTavusFailed] = useState(false);
  const [tavusLive, setTavusLive] = useState(false);
  // True while a live avatar (Simli or Tavus) is connecting for the first
  // time this lesson — blocks the whole UI behind a full-screen loader so
  // the learner never sees a static/half-animated avatar mid-connect (SRS
  // §avatar-readiness). Never true for personas without a live avatar.
  const [avatarConnecting, setAvatarConnecting] = useState(false);
  const mouthTimer = useRef(null);
  const stopSpeechRef = useRef(null);
  // Bumped on every new speakWithMouth() call and on any pause/stop. Async
  // speech attempts capture the value at their start and re-check it after
  // each await; if it no longer matches, a newer attempt has taken over (or
  // playback was cancelled) and this one quietly drops itself instead of
  // playing stale audio — this is what fixes narration/answers that used to
  // surface many seconds late (sometimes in the Web Speech fallback voice)
  // because an old in-flight TTS fetch had no way to know it was obsolete.
  const speechGenRef = useRef(0);
  const threadRef = useRef([]);
  threadRef.current = thread;
  // Absolute character position narration was interrupted at, and the full
  // (presenter-substituted) segment text it belongs to — lets raising a hand
  // or hitting pause resume from that exact spot instead of restarting the
  // segment, since the Web Speech API has no native "seek".
  const lastCharRef = useRef(0);
  const fullTextRef = useRef('');
  // Time-based progress-estimator interval (see speakWithMouth) and a flag
  // that tells its onEnd handler whether the utterance was deliberately
  // interrupted (pause/stop) rather than finished naturally.
  const progressTimerRef = useRef(null);
  const interruptedRef = useRef(false);

  // Live Simli video avatar: only ever shown once a real audio track is
  // captured (see ensureLiveAvatar) — otherwise the static animated photo is
  // used, since a Simli video with no audio at all just goes idle/black.
  const simliFaceId = SIMLI_FACES[avatarId];
  const simliRef = useRef(null);
  const simliAttemptedRef = useRef(false);
  // True once the Simli connection has actually reported 'live' — used to
  // decide whether narration still needs to wait (and show the blocking
  // loader) or can start instantly against the already-connected avatar.
  const simliUpRef = useRef(false);
  const narrationStreamRef = useRef(null);
  const recognitionRef = useRef(null);
  const voiceModeRef = useRef(false);

  // Live Tavus video avatar (Amara): connecting is async and Tavus is the
  // *only* audio source for this persona, so the first speak has to await a
  // real connection before it can say anything (see ensureTavusAvatar).
  const isTavus = Boolean(TAVUS_PERSONAS[avatarId]);
  const tavusRef = useRef(null);
  const tavusReadyRef = useRef(null); // Promise<boolean>, set once connecting starts
  const tavusStartResolveRef = useRef(null);
  const tavusStoppedResolveRef = useRef(null);

  const QA_MIN = 260; const QA_MAX = 640; const QA_DEFAULT = 320;
  const splitRef = useRef(null);
  const [qaWidth, setQaWidth] = useState(() => {
    const saved = Number(localStorage.getItem('ilp.qaWidth'));
    return saved >= QA_MIN && saved <= QA_MAX ? saved : QA_DEFAULT;
  });
  const clampWidth = (w) => Math.max(QA_MIN, Math.min(QA_MAX, w));
  function persistWidth(w) { setQaWidth(w); try { localStorage.setItem('ilp.qaWidth', String(w)); } catch { /* noop */ } }
  function startDrag(e) {
    e.preventDefault();
    const onMove = (ev) => {
      const box = splitRef.current && splitRef.current.getBoundingClientRect();
      if (!box) return;
      const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      persistWidth(clampWidth(box.right - clientX));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false }); window.addEventListener('touchend', onUp);
  }
  function dividerKey(e) {
    if (e.key === 'ArrowLeft') persistWidth(clampWidth(qaWidth + 24));
    else if (e.key === 'ArrowRight') persistWidth(clampWidth(qaWidth - 24));
  }

  const segment = mod && mod.segments[seg];
  const steps = useMemo(() => (segment && segment.steps) || [], [segment]);
  // Narration text is authored once and reused for every presenter; swap the
  // {{presenter}} token for whichever avatar the learner actually picked so
  // Mei-Lin doesn't introduce herself as "Mira".
  const presenterText = (text) => (text || '').split('{{presenter}}').join(presenterName);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    api.module(moduleId, lang)
      .then((m) => { if (alive) { setMod(m); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e.message || ui.errorGeneric); setLoading(false); } });
    return () => { alive = false; stopAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleId, lang]);

  useEffect(() => { setRevealed(0); setShowCheck(false); return stopAll; /* eslint-disable-next-line */ }, [seg, mod]);

  useEffect(() => {
    let alive = true;
    if (speechSupported()) pickVoiceName(lang).then((n) => { if (alive) setVoiceName(n || ''); });
    return () => { alive = false; };
  }, [lang]);

  // Hard stop: cancels speech outright and forgets any resume position. Used
  // for segment navigation and unmount — a real "leave this moment" action,
  // unlike pauseNarration() which deliberately remembers where it stopped.
  function stopAll() {
    interruptedRef.current = true;
    speechGenRef.current += 1;
    if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
    if (mouthTimer.current) { clearInterval(mouthTimer.current); mouthTimer.current = null; }
    if (stopSpeechRef.current) { stopSpeechRef.current(); stopSpeechRef.current = null; }
    cancelSpeech();
    setSpeaking(false); setMouth(false); setPaused(false);
    lastCharRef.current = 0; fullTextRef.current = '';
    stopVoiceMode();
  }

  // Soft stop: cancels the current utterance (so a prompt/answer can speak
  // right away) but keeps lastCharRef/fullTextRef intact, so resumeNarration()
  // can continue the segment from exactly this point. interruptedRef is the
  // key bit: it tells the in-flight speakWithMouth's onEnd handler (which
  // *will* still fire once cancelSpeech() below interrupts the utterance)
  // that this wasn't a natural finish, so it must not clobber lastCharRef.
  function pauseNarration() {
    interruptedRef.current = true;
    speechGenRef.current += 1;
    if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
    if (mouthTimer.current) { clearInterval(mouthTimer.current); mouthTimer.current = null; }
    if (stopSpeechRef.current) { stopSpeechRef.current(); stopSpeechRef.current = null; }
    cancelSpeech();
    setSpeaking(false); setMouth(false); setPaused(true);
  }

  function resumeNarration() {
    const full = fullTextRef.current;
    const from = lastCharRef.current;
    setPaused(false);
    if (!full || from >= full.length) return;
    speakWithMouth(full.slice(from), { driveBoard: true, charOffset: from, fullLen: full.length });
  }

  // Ends the live mic capture (speech recognition only — it manages its own
  // microphone access, no separate getUserMedia needed).
  function stopVoiceMode() {
    voiceModeRef.current = false;
    if (recognitionRef.current) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      rec.onend = null; // don't let the auto-restart handler fire after an intentional stop
      try { rec.stop(); } catch { /* noop */ }
    }
    setVoiceMode(false);
  }

  // Holds the captured audio track between "we got it" and "the SimliAvatar
  // element exists to hand it to" — setLiveNarration(true) mounts
  // <SimliAvatar>, and the effect below calls .start() once its ref is
  // actually attached (can't call simliRef.current.start() directly from
  // ensureLiveAvatarFromElement: it isn't rendered yet, since rendering it is
  // gated on liveNarration).
  const pendingAudioTrackRef = useRef(null);
  // The hidden <audio> element (rendered near the presenter, below) that
  // plays our own server-synthesized narration. Its captureStream() is what
  // actually drives Simli — no browser permission prompt needed for that,
  // unlike capturing the whole tab.
  const narrationAudioRef = useRef(null);

  // Grabs the narration <audio> element's own output as a live track and
  // hands it to Simli — captureStream() can be called before the element
  // ever plays anything; the track just carries silence until real audio
  // starts flowing through the element, so this can (and must) run BEFORE
  // el.play() rather than after. That's what lets speakViaServerTts wait for
  // Simli to actually report "live" before starting playback at all, instead
  // of playing audio immediately against a static photo and swapping to
  // video mid-sentence once Simli catches up (SRS §avatar-readiness).
  //
  // Returns a promise resolving true once Simli reports 'live', or false on
  // error/unsupported (caller falls back to the static photo). Only ever
  // attempts once per lesson — cached in simliConnectReadyRef.
  const simliConnectReadyRef = useRef(null);
  const simliConnectResolveRef = useRef(null);
  function ensureLiveAvatarFromElement(el) {
    if (!simliFaceId) return Promise.resolve(false);
    if (simliConnectReadyRef.current) return simliConnectReadyRef.current;
    simliConnectReadyRef.current = new Promise((resolve) => {
      if (simliAttemptedRef.current) { resolve(false); return; }
      simliAttemptedRef.current = true;
      try {
        const captureFn = el.captureStream || el.mozCaptureStream;
        if (!captureFn) { resolve(false); return; }
        const stream = captureFn.call(el);
        const track = stream.getAudioTracks()[0];
        if (!track) { resolve(false); return; }
        narrationStreamRef.current = stream;
        pendingAudioTrackRef.current = track;
        simliConnectResolveRef.current = resolve;
        // captureStream() taps the element's decoded audio before the
        // volume/mute stage, so muting local playback here does NOT affect
        // what Simli receives — it only stops the learner hearing the same
        // line twice (once locally, once relayed back via Simli's own
        // lip-synced audio track).
        el.muted = true;
        setSimliFailed(false);
        setLiveNarration(true); // mounts <SimliAvatar>; effect below calls .start()
      } catch {
        resolve(false); // Unsupported — silently keep the static animated photo.
      }
    });
    return simliConnectReadyRef.current;
  }

  // Fires once <SimliAvatar> actually mounts (right after
  // ensureLiveAvatarFromElement sets liveNarration true) and hands it the
  // audio track we already captured. Resolving simliConnectResolveRef is done
  // from the SimliAvatar onStatusChange callback in the JSX below (status
  // 'live'/'error'), not here — .start() resolving just means the client
  // object was created, not that the WebRTC connection is actually up.
  useEffect(() => {
    if (!liveNarration || !simliRef.current || !pendingAudioTrackRef.current) return;
    const track = pendingAudioTrackRef.current;
    pendingAudioTrackRef.current = null;
    simliRef.current.start(track, simliFaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveNarration]);

  // Mounts <TavusAvatar> (if not already) and returns a promise that
  // resolves once it's actually connected (or false on failure). Callers
  // must await this before sending the first line — unlike Simli, Tavus is
  // the only source of audio here, so there's nothing to hear until the
  // Daily call is actually joined.
  function ensureTavusAvatar() {
    if (!isTavus) return Promise.resolve(false);
    if (tavusReadyRef.current) return tavusReadyRef.current;
    tavusReadyRef.current = new Promise((resolve) => { tavusStartResolveRef.current = resolve; });
    setTavusLive(true); // mounts <TavusAvatar>; the effect below calls .start()
    return tavusReadyRef.current;
  }

  // Fires once <TavusAvatar> actually mounts (right after ensureTavusAvatar
  // sets tavusLive true) and kicks off the connection.
  useEffect(() => {
    if (!tavusLive || !tavusRef.current) return;
    tavusRef.current.start().then((conversationId) => {
      if (tavusStartResolveRef.current) {
        tavusStartResolveRef.current(Boolean(conversationId));
        tavusStartResolveRef.current = null;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tavusLive]);

  // Pre-warm the live avatar the moment the classroom opens (SRS FR-FLOW-0 /
  // FR-AV-5/8): the connection cost is paid once, up front, behind the
  // blocking loader — so when narration actually starts there is no avatar
  // delay at all, and the learner only ever sees the service-rendered live
  // video, never a static stand-in. Applies to both providers.
  useEffect(() => {
    if (simliFaceId) {
      const el = narrationAudioRef.current;
      if (!el) return;
      setAvatarConnecting(true);
      Promise.race([
        ensureLiveAvatarFromElement(el),
        new Promise((resolve) => { setTimeout(() => resolve(false), 15000); }),
      ]).then((ok) => {
        simliUpRef.current = ok;
        setAvatarConnecting(false);
        if (!ok) setSimliFailed(true);
      });
    } else if (isTavus) {
      setAvatarConnecting(true);
      ensureTavusAvatar().then((ok) => {
        setAvatarConnecting(false);
        if (!ok) setTavusFailed(true);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Broadcasts narration text to the live Tavus avatar and waits for Tavus's
  // own conversation.stopped_speaking event before resolving — that's the
  // real end of speech (Tavus does its own TTS + lip-synced video), not a
  // local audio element finishing. Returns true if it handled playback.
  async function speakViaTavus(text, {
    charOffset, textLen, driveBoard, nSteps, finish,
  }) {
    const alreadyConnected = Boolean(tavusReadyRef.current);
    if (!alreadyConnected) setAvatarConnecting(true);
    const ok = await ensureTavusAvatar();
    setAvatarConnecting(false);
    if (!ok || !tavusRef.current) return false;

    let resolveStopped;
    const stopped = new Promise((resolve) => { resolveStopped = resolve; });
    tavusStoppedResolveRef.current = resolveStopped;
    // Reuses the same stopSpeechRef mechanism pauseNarration()/stopAll()
    // already call — but for Tavus this must also tell the PAL server-side
    // to actually stop talking, not just resolve our local promise.
    stopSpeechRef.current = () => {
      tavusStoppedResolveRef.current = null;
      if (tavusRef.current) tavusRef.current.interrupt();
      resolveStopped();
    };

    const CHARS_PER_MS = 0.0152; // same estimate used for the Web Speech fallback
    const startedAt = Date.now();
    if (driveBoard) {
      progressTimerRef.current = setInterval(() => {
        const estAbs = charOffset + (Date.now() - startedAt) * CHARS_PER_MS;
        lastCharRef.current = Math.max(lastCharRef.current, Math.min(estAbs, textLen));
        setRevealed((r) => Math.max(r, revealedFromProgress(lastCharRef.current, textLen, nSteps)));
      }, 200);
    }

    tavusRef.current.sendText(text);
    await stopped;
    finish();
    return true;
  }

  // Synthesizes text on the backend (Gemini TTS) and plays it through the
  // hidden narration <audio> element, tracking progress from its real
  // currentTime/duration — far more accurate than the Web Speech estimate
  // below. Returns true if it handled playback, false if the caller should
  // fall back to the browser's Web Speech API (TTS unavailable/failed).
  //
  // Connection order matters here (SRS §avatar-readiness): Simli is wired up
  // to the audio element and awaited to reach 'live' status BEFORE el.play()
  // is ever called, so the very first frame the learner sees already has
  // real lip-sync — never a static photo with blinking lips that later swaps
  // to video mid-sentence. A 10s cap keeps a stuck connection from hanging
  // the lesson forever; if it doesn't come up in time we just fall back to
  // the static photo and play the audio anyway.
  //
  // The Simli connection attempt (only ever made once per lesson) is kicked
  // off BEFORE awaiting the TTS fetch, not after — captureStream() works
  // fine on an <audio> element with no src yet, so the two slow steps run in
  // parallel instead of stacking. Previously a slow TTS response (which
  // scales with paragraph length — several seconds is normal for a full
  // segment) was fully paid for before the up-to-10s Simli wait even began,
  // which is what made the loading overlay take 20-30s combined.
  async function speakViaServerTts(text, {
    charOffset, textLen, driveBoard, nSteps, finish, myGen,
  }) {
    const el = narrationAudioRef.current;
    if (!el) return false;

    // The connection itself is normally already up — it's pre-warmed on
    // classroom mount (see the effect above). Awaiting the cached promise is
    // then instant; the overlay only appears in the rare case the pre-warm
    // hasn't finished (or was skipped) by the time narration starts.
    const showOverlay = Boolean(simliFaceId) && !simliUpRef.current;
    if (showOverlay) setAvatarConnecting(true);
    const simliPromise = simliFaceId
      ? Promise.race([
          ensureLiveAvatarFromElement(el),
          new Promise((resolve) => { setTimeout(() => resolve(false), 10000); }),
        ])
      : null;

    let objectUrl;
    try {
      const blob = await fetchTtsAudio(text, 'Gacrux');
      objectUrl = URL.createObjectURL(blob);
    } catch {
      if (showOverlay) setAvatarConnecting(false);
      return false; // TTS unavailable this time — Web Speech API takes over
    }

    // A newer speakWithMouth() call (segment change, pause, raise hand)
    // started while this fetch was in flight — this line is stale, so drop
    // it instead of playing audio for a moment the learner already left.
    // Report "handled" so the caller does NOT additionally fall back to Web
    // Speech for a line nobody is waiting on anymore.
    if (myGen !== speechGenRef.current) {
      if (showOverlay) setAvatarConnecting(false);
      URL.revokeObjectURL(objectUrl);
      return true;
    }

    el.src = objectUrl;

    if (simliPromise) {
      const ok = await simliPromise;
      if (showOverlay) setAvatarConnecting(false);
      if (ok) simliUpRef.current = true;
      else setSimliFailed(true);
      if (myGen !== speechGenRef.current) {
        URL.revokeObjectURL(objectUrl);
        return true;
      }
    }

    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const onEnded = () => resolveDone();
    el.addEventListener('ended', onEnded, { once: true });
    // Reuses the same stopSpeechRef mechanism pauseNarration()/stopAll()
    // already call for the Web Speech path — no changes needed there.
    stopSpeechRef.current = () => {
      el.removeEventListener('ended', onEnded);
      el.pause();
      resolveDone();
    };

    if (driveBoard) {
      progressTimerRef.current = setInterval(() => {
        if (!el.duration) return;
        const abs = charOffset + (el.currentTime / el.duration) * Math.max(0, textLen - charOffset);
        lastCharRef.current = Math.max(lastCharRef.current, Math.min(abs, textLen));
        setRevealed((r) => Math.max(r, revealedFromProgress(lastCharRef.current, textLen, nSteps)));
      }, 150);
    }

    try {
      await el.play();
    } catch {
      // Autoplay blocked or similar — fall back to Web Speech for this line.
      if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
      el.removeEventListener('ended', onEnded);
      stopSpeechRef.current = null;
      URL.revokeObjectURL(objectUrl);
      return false;
    }
    await done;
    URL.revokeObjectURL(objectUrl);
    finish();
    return true;
  }

  async function speakWithMouth(text, {
    onEnd, driveBoard, charOffset = 0, fullLen,
  } = {}) {
    const myGen = ++speechGenRef.current;
    setSpeaking(true);
    interruptedRef.current = false;
    if (mouthTimer.current) clearInterval(mouthTimer.current);
    mouthTimer.current = setInterval(() => setMouth((v) => !v), 220);
    const textLen = fullLen ?? (text || '').length;
    const nSteps = driveBoard ? steps.length : 0;
    if (driveBoard && charOffset === 0) setRevealed(nSteps > 0 ? 1 : 0);
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);

    const finish = () => {
      if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
      if (mouthTimer.current) { clearInterval(mouthTimer.current); mouthTimer.current = null; }
      setSpeaking(false); setMouth(false);
      const wasInterrupted = interruptedRef.current;
      interruptedRef.current = false;
      if (driveBoard && !wasInterrupted) { setRevealed(nSteps); lastCharRef.current = textLen; }
      if (onEnd) onEnd();
    };

    // Personas with a live Simli face get real, server-synthesized speech so
    // the avatar's lip-sync matches her actual voice. Everyone else (and
    // Simli personas if the TTS call fails) uses the browser's Web Speech
    // API, same as always.
    if (simliFaceId) {
      const handled = await speakViaServerTts(text, {
        charOffset, textLen, driveBoard, nSteps, finish, myGen,
      });
      if (handled) return;
    }

    // Amara: try the live Tavus avatar first — real voice + lip-synced video,
    // rendered entirely on Tavus's end. Falls through to Web Speech below if
    // the conversation can't be started (offline, quota, misconfigured).
    if (isTavus) {
      const handled = await speakViaTavus(text, {
        charOffset, textLen, driveBoard, nSteps, finish,
      });
      if (handled) return;
    }

    // Chrome's SpeechSynthesisUtterance "boundary" event doesn't fire at all
    // for some network voices (confirmed: zero boundary events over a full
    // utterance with the "Google US English" voice) — so board reveal and
    // the pause/resume position are estimated from elapsed time as the
    // primary driver. If boundary events *do* fire on a given browser/voice,
    // they still update the same ref with a (more accurate) value.
    const CHARS_PER_MS = 0.0152; // ~160 wpm at the utterance's rate (0.97)
    const startedAt = Date.now();
    if (driveBoard) {
      progressTimerRef.current = setInterval(() => {
        const estAbs = charOffset + (Date.now() - startedAt) * CHARS_PER_MS;
        lastCharRef.current = Math.max(lastCharRef.current, Math.min(estAbs, textLen));
        setRevealed((r) => Math.max(r, revealedFromProgress(lastCharRef.current, textLen, nSteps)));
      }, 200);
    }

    stopSpeechRef.current = await speak(text, lang, {
      onBoundary: driveBoard ? (ci) => {
        const abs = charOffset + ci;
        lastCharRef.current = Math.max(lastCharRef.current, abs);
        setRevealed((r) => Math.max(r, revealedFromProgress(lastCharRef.current, textLen, nSteps)));
      } : undefined,
      onEnd: finish,
    });
    if (!speechSupported()) finish();
  }

  function play() {
    if (!segment) return;
    setShowCheck(false);
    const full = presenterText(segment.text);
    fullTextRef.current = full;
    lastCharRef.current = 0;
    setPaused(false);
    speakWithMouth(full, { driveBoard: true });
  }
  function togglePlay() {
    if (speaking) { pauseNarration(); return; }
    if (paused) { resumeNarration(); return; }
    play();
  }
  function raiseHand() {
    // Tapping the raised hand again lowers it and continues the lesson from
    // exactly where narration was interrupted.
    if (handUp) { resume(); return; }
    pauseNarration(); setHandUp(true);
    setThread((t) => [...t, { role: 'presenter', text: ui.questionTitle }]);
    if (ui.raiseHandPrompt) speakWithMouth(ui.raiseHandPrompt, { driveBoard: false });
  }
  function resume() {
    stopVoiceMode();
    setHandUp(false);
    resumeNarration();
  }

  async function submitQuestion(text, viaVoice = false) {
    const q = (text ?? question).trim();
    if (!q) return;
    if (!handUp) { pauseNarration(); setHandUp(true); }
    const history = threadRef.current
      .filter((m) => m.role === 'learner' || (m.role === 'presenter' && m.topicality))
      .map((m) => ({ role: m.role, text: m.text }));
    setThread((t) => [...t, { role: 'learner', text: q, viaVoice }]);
    setQuestion(''); setAsking(true); setThinking(true);
    try {
      const res = await api.ask({ moduleId, lang, question: q, history, askedByVoice: viaVoice });
      setThinking(false);
      setThread((t) => [...t, {
        role: 'presenter', text: res.answer, topicality: res.topicality, source: res.source, sources: res.sources,
      }]);
      if ((viaVoice || voiceReplies) && speechSupported()) speakWithMouth(res.answer, { driveBoard: false });
    } catch (e) {
      setThinking(false);
      setThread((t) => [...t, { role: 'presenter', text: e.message || ui.errorGeneric, topicality: 'error' }]);
    } finally { setAsking(false); }
  }

  // Pressing the Speak tab is the one and only mic trigger: it turns speech
  // recognition on continuously (not just for one question), and it stays on
  // until the learner lowers their raised hand (see resume(), which calls
  // stopVoiceMode()). SpeechRecognition manages its own microphone access —
  // no separate getUserMedia call needed. The live avatar's lip-sync is
  // driven separately, by the learner's own captured tab audio (see
  // ensureLiveAvatar), not by this mic — she should only ever appear to
  // speak when she's actually speaking.
  function startVoiceMode() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert(ui.voiceUnsupported); return; }
    if (voiceModeRef.current) return;
    cancelSpeech();
    voiceModeRef.current = true;
    setVoiceMode(true);
    const rec = new SR();
    rec.lang = langTag(lang);
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (ev) => {
      const res = ev.results[ev.results.length - 1];
      if (res && res.isFinal) submitQuestion(res[0].transcript, true);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // keep listening
      stopVoiceMode();
    };
    rec.onend = () => {
      // Some browsers end recognition after a short silence even with
      // continuous:true — restart automatically while voice mode is still on.
      if (voiceModeRef.current) { try { rec.start(); } catch { /* already running */ } }
    };
    try { rec.start(); } catch { /* noop */ }
    recognitionRef.current = rec;
  }

  function goSegment(next) {
    stopAll();
    const clamped = Math.max(0, Math.min((mod.segments.length - 1), next));
    setSeg(clamped); onSaved(clamped);
  }

  if (loading) return <div className="room"><Spinner label={ui.loading} /></div>;
  if (error) return <div className="room"><ErrorBanner msg={error} onRetry={() => window.location.reload()} /></div>;
  if (!mod || mod.segments.length === 0) return <div className="room"><div className="state">{ui.empty}</div></div>;

  const isLast = seg >= mod.segments.length - 1;
  const avatarState = handUp && !speaking ? 'listening' : (thinking ? 'listening' : 'idle');

  return (
    <div className="room">
      {avatarConnecting && (
        <div className="avatar-loading-overlay" role="alert" aria-live="assertive">
          <Spinner label={ui.avatarLoading || 'Loading the presenter…'} />
        </div>
      )}
      <div className="topbar">
        <div className="crumb"><b>{course.title}</b><span>·</span><span className="mod">{mod.title}</span></div>
        <button className="ghost" onClick={onExit}>← {ui.moduleList}</button>
      </div>

      <div className="split" ref={splitRef}>
        <div className="left-pane">
          <div className="stage">
            <div className={`board-col ${captionsOn && !showCheck ? 'with-captions' : ''}`}>
              <div className="board">
                {showCheck && mod.check
                  ? <KnowledgeCheck check={mod.check} ui={ui} onClose={() => setShowCheck(false)} />
                  : <Board steps={steps} revealed={revealed} />}
              </div>
              {captionsOn && !showCheck && (
                <div className="captions">
                  <div className="cc-label">{ui.captions} · {lang.toUpperCase()}</div>
                  <div>{presenterText(segment.text)}</div>
                </div>
              )}
            </div>

            {/* Presenter dock: bottom-right of the lesson area, left of the
                Q&A pane and directly above the Raise hand button, sharing its
                exact width (--presenter-w, SRS §UI). For live-avatar personas
                the video here is the ONLY rendering — all animation comes
                from the avatar service itself, never a photo or CSS mouth. */}
            <div className="presenter-dock">
              {simliFaceId ? (
                <SimliAvatar
                  ref={simliRef}
                  size={150}
                  onStatusChange={(s) => {
                    if (s === 'live') simliUpRef.current = true;
                    if (s === 'error') { simliUpRef.current = false; setSimliFailed(true); }
                    if ((s === 'live' || s === 'error') && simliConnectResolveRef.current) {
                      simliConnectResolveRef.current(s === 'live');
                      simliConnectResolveRef.current = null;
                    }
                  }}
                />
              ) : isTavus && tavusLive && !tavusFailed ? (
                <TavusAvatar
                  ref={tavusRef}
                  size={150}
                  onStatusChange={(s) => { if (s === 'error') setTavusFailed(true); }}
                  onStoppedSpeaking={() => {
                    if (tavusStoppedResolveRef.current) {
                      tavusStoppedResolveRef.current();
                      tavusStoppedResolveRef.current = null;
                    }
                  }}
                />
              ) : (
                <Avatar id={avatarId} mouth={mouth} state={avatarState} size={150} />
              )}
              <div className={`badge ${(speaking || thinking) ? 'on' : ''}`}>
                {thinking ? ui.thinking : (speaking ? ui.speaking : (handUp ? ui.listening : presenterName))}
              </div>
              {/* Hidden player for server-synthesized speech (Simli personas
                  only) — never shown, its captureStream() is what feeds the
                  live avatar; see ensureLiveAvatarFromElement. */}
              {simliFaceId && <audio ref={narrationAudioRef} style={{ display: 'none' }} />}
            </div>
          </div>

          <div className="controls">
            <button className="tbtn" onClick={() => goSegment(seg - 1)} disabled={avatarConnecting || seg === 0} aria-label={ui.type}>⏮</button>
            <button className="tbtn play" onClick={togglePlay} disabled={avatarConnecting} aria-label={ui.play}>{speaking ? '⏸' : '▶'}</button>
            <button className="tbtn" onClick={() => goSegment(seg + 1)} disabled={avatarConnecting || isLast} aria-label={ui.next}>⏭</button>
            <div className="progress">
              <span>{`${ui.module} ${mod.order || ''} · ${seg + 1}/${mod.segments.length}`}</span>
              <div className="track"><i style={{ width: `${((seg + 1) / mod.segments.length) * 100}%` }} /></div>
            </div>
            <button className={`chip ${captionsOn ? 'on' : ''}`} disabled={avatarConnecting} onClick={() => setCaptionsOn((v) => !v)}>💬 {ui.captions}</button>
            {mod.check && <button className={`chip ${showCheck ? 'on' : ''}`} disabled={avatarConnecting} onClick={() => { stopAll(); setShowCheck((v) => !v); }}>🎯 {ui.knowledgeCheck}</button>}
            <button className={`raise ${handUp ? 'lit' : ''}`} onClick={raiseHand}>✋ {ui.raiseHand}</button>
          </div>
        </div>

        <div className="divider" role="separator" aria-orientation="vertical" aria-label={ui.qaTitle}
          tabIndex={0} onMouseDown={startDrag} onTouchStart={startDrag} onKeyDown={dividerKey}
          onDoubleClick={() => persistWidth(QA_DEFAULT)}><span className="grip" /></div>

        <aside className="right-pane" style={{ width: qaWidth }}>
          <div className="qa-head">
            <b>💬 {ui.qaTitle}</b>
            <div className="qa-tools">
              <button className={`chip ${voiceReplies ? 'on' : ''}`} onClick={() => setVoiceReplies((v) => !v)} title={ui.voiceReplies}>
                {voiceReplies ? '🔊' : '🔇'} {ui.voiceReplies}
              </button>
              {handUp && <button className="link" onClick={resume}>✕ {ui.noMore} ▶</button>}
            </div>
          </div>
          <div className="qa-thread">
            {thread.length === 0 && !asking && <div className="qa-hint">{handUp ? ui.questionTitle : ui.askPrompt}</div>}
            {thread.map((m, i) => (
              <div key={i} className={`bubble ${m.role === 'learner' ? 'q' : 'a'} ${m.topicality === 'off' ? 'off' : ''} ${m.topicality === 'error' ? 'errb' : ''}`}>
                {m.role === 'learner' && m.viaVoice && <span className="mic-tag">🎙</span>}
                {m.text}
                {m.source && <span className="src">{ui.onTopicSource} · {(m.sources && m.sources.join(', ')) || m.source}</span>}
              </div>
            ))}
            {asking && <div className="bubble a"><Spinner label={ui.thinking} /></div>}
          </div>
          <div className="ask">
            <div className="mode">
              <button className={!voiceMode ? 'sel' : ''} onClick={() => stopVoiceMode()}>⌨ {ui.type}</button>
              <button className={voiceMode ? 'sel' : ''} onClick={startVoiceMode}>🎙 {ui.speak}</button>
            </div>
            {!voiceMode ? (
              <div className="ask-row">
                <input value={question} placeholder={ui.askPlaceholder}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitQuestion()} />
                <button className="primary sm" onClick={() => submitQuestion()} disabled={asking}>{ui.ask}</button>
              </div>
            ) : (
              <div className="voice">
                <span className="mic-live" aria-hidden="true" />
                <span className="hint">{ui.holdToTalk}</span>
              </div>
            )}
            {speechSupported() && voiceName && <div className="voicename">🗣 {ui.voice}: {voiceName}</div>}
            {!speechSupported() && <div className="voicename">{ui.voiceUnavailable || ''}</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ---------------- course shell ---------------- */
function CourseApp({ user, onLogout }) {
  const [lang, setLang] = useState('en');
  const [ui, setUi] = useState(null);
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState('welcome');
  const [avatarId, setAvatarId] = useState('mira');
  const [moduleId, setModuleId] = useState(null);
  const [initialSegment, setInitialSegment] = useState(0);
  const [toast, setToast] = useState('');

  async function loadAll(l) {
    setLoading(true); setError('');
    try {
      const [u, c] = await Promise.all([api.uiStrings(l), api.course(l)]);
      setUi(u); setCourse(c);
      try {
        const p = await api.getProgress();
        if (p) {
          if (p.avatar_id) setAvatarId(p.avatar_id);
          if (p.module_id) { setModuleId(p.module_id); setInitialSegment(p.segment_index || 0); }
        }
      } catch { /* no progress yet */ }
      setLoading(false);
    } catch (e) { setError(e.message || 'Failed to load'); setLoading(false); }
  }
  useEffect(() => { loadAll(lang); /* eslint-disable-next-line */ }, [lang]);

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(''), 1800); }
  async function saveProgress(nextSegment) {
    try {
      await api.saveProgress({ courseId: COURSE_ID, moduleId, segmentIndex: nextSegment ?? initialSegment, lang, avatarId });
      showToast(ui.saved);
    } catch { showToast(ui.errorGeneric); }
  }

  if (loading || !ui) return <div className="shell"><Spinner label="Loading…" /></div>;

  return (
    <div className="shell">
      <header className="appbar">
        <div className="brand"><span className="glyph" /> <b>{ui.appName}</b></div>
        <div className="appbar-right">
          <div className="lang">
            {(course.supportedLanguages || ['en']).map((l) => (
              <button key={l} className={lang === l ? 'sel' : ''} onClick={() => setLang(l)}>{l.toUpperCase()}</button>
            ))}
          </div>
          <span className="who">{(user && user.displayName) || ''}</span>
          <button className="ghost" onClick={onLogout}>{ui.logout}</button>
        </div>
      </header>

      <ErrorBanner msg={error} onRetry={() => loadAll(lang)} />

      {view === 'welcome' && (
        <section className="welcome">
          <div className="wcopy">
            <div className="eyebrow">{course.title}</div>
            <h1>{ui.tagline}</h1>
            <p>{course.modules.length} {ui.moduleList.toLowerCase()} · {(course.supportedLanguages || []).join(' / ').toUpperCase()}</p>
            <div className="wsteps">{course.modules.map((m) => <span key={m.id} className="wstep">{m.title}</span>)}</div>
            <div className="wcta">
              <button className="primary" onClick={() => setView('avatars')}>{ui.startCourse}</button>
              {moduleId && <button className="ghost" onClick={() => setView('classroom')}>{ui.resume}</button>}
            </div>
          </div>
        </section>
      )}

      {view === 'avatars' && (
        <section className="sel">
          {/* Header row spans exactly the cards' width: the heading sits
              flush with the first card's left edge, Continue with the last
              card's right edge. */}
          <div className="sel-head">
            <h2>{ui.choosePresenter}</h2>
            <button className="primary" onClick={() => setView('modules')}>{ui.continue}</button>
          </div>
          <div className="cards">
            {course.avatars.map((a) => (
              <button key={a.id} className={`acard ${avatarId === a.id ? 'sel' : ''}`} onClick={() => setAvatarId(a.id)}>
                <Avatar id={a.id} size={140} />
                <b>{a.name}</b><span className="role">{a.role}</span>
                <span className="desc">{a.desc}</span>
                <span className="pickbtn">{avatarId === a.id ? `${ui.selected} ✓` : ui.choose}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {view === 'modules' && (
        <section className="sel">
          <h2>{ui.moduleList}</h2>
          {course.modules.length === 0 ? <div className="state">{ui.empty}</div> : (
            <div className="mlist">
              {course.modules.map((m, i) => (
                <button key={m.id} className="mrow" onClick={() => { setModuleId(m.id); setInitialSegment(0); setView('classroom'); }}>
                  <span className="mnum">{i + 1}</span>
                  <span className="mtitle">{m.title}</span>
                  <span className="msum">{m.summary}</span>
                  <span className="mmin">{m.estimatedMinutes} {ui.estMin}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {view === 'classroom' && moduleId && (
        <Classroom
          ui={ui} lang={lang} avatarId={avatarId} course={course}
          moduleId={moduleId} initialSegment={initialSegment}
          onExit={() => setView('modules')}
          onSaved={(nextSegment) => { setInitialSegment(nextSegment); saveProgress(nextSegment); }}
        />
      )}

      <Toast msg={toast} />
    </div>
  );
}

/* ---------------- root ---------------- */
export default function App() {
  const [user, setUser] = useState(null);
  const [booted, setBooted] = useState(false);
  const [ui, setUi] = useState(null);

  useEffect(() => {
    api.uiStrings('en').then(setUi).catch(() => setUi({}));
    async function boot() {
      if (getToken()) {
        try { await api.getProgress(); setUser({ displayName: 'Learner' }); return; } catch { setToken(null); }
      }
      try { const res = await api.guest(); setToken(res.token); setUser(res.user); } catch { setUser(null); }
    }
    boot().finally(() => setBooted(true));
  }, []);

  if (!booted || !ui) return <div className="shell"><Spinner label="Loading…" /></div>;
  if (!user) {
    return (
      <div className="shell">
        <ErrorBanner msg="Could not start a session." onRetry={() => window.location.reload()} />
      </div>
    );
  }
  return <CourseApp user={user} onLogout={() => { setToken(null); window.location.reload(); }} />;
}
