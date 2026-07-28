import React, {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { api, getToken, setToken } from './api.js';
import { avatarSVG } from './avatar.js';
import SimliAvatar from './SimliAvatar.jsx';
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

function Avatar({ id, mouth, state, size = 180 }) {
  // Content-driven photo avatars: drop course-content/avatars/<id>.jpg and it
  // replaces the drawn SVG automatically, no code change needed per persona.
  // This is always the default view — including for personas with a live
  // Simli face (SIMLI_FACES): the CSS mouth/bob animation below is what
  // actually moves reliably in sync with speech. Classroom only swaps to the
  // live SimliAvatar video once it has captured real audio to feed it (see
  // ensureLiveAvatar) — a Simli video with no live audio track goes idle and
  // eventually blacks out, so it's never worth showing without a real source.
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
  const [captionsOn, setCaptionsOn] = useState(true);
  const [showCheck, setShowCheck] = useState(false);
  const [voiceName, setVoiceName] = useState('');
  const [paused, setPaused] = useState(false);
  const [simliFailed, setSimliFailed] = useState(false);
  const [liveNarration, setLiveNarration] = useState(false);
  const mouthTimer = useRef(null);
  const stopSpeechRef = useRef(null);
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
  const narrationStreamRef = useRef(null);
  const recognitionRef = useRef(null);
  const voiceModeRef = useRef(false);

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
  // element exists to hand it to" — setLiveNarration(true) below mounts
  // <SimliAvatar>, and the effect further down calls .start() once its ref
  // is actually attached (can't call simliRef.current.start() directly inside
  // ensureLiveAvatar: it isn't rendered yet, since rendering it is gated on
  // liveNarration).
  const pendingAudioTrackRef = useRef(null);

  // Captures the tab's own audio output (once, on the learner's first Play
  // click — a real user gesture, required for getDisplayMedia) and feeds it
  // to the live Simli avatar as a persistent track for the rest of the
  // lesson. Whatever plays through this tab from that point on — segment
  // narration, the raise-hand prompt, Q&A answers, all of which go through
  // the same speak() call — drives real lip-sync, since Simli only needs
  // *a* live audio track, not necessarily one from a microphone.
  // A Simli connection with no audio at all goes idle and eventually blacks
  // out (confirmed by hand), so this is the only way to get a moving avatar
  // instead of the static animated photo. If the browser denies/doesn't
  // support this, we just keep using the static photo — no error shown.
  async function ensureLiveAvatar() {
    if (!simliFaceId || simliAttemptedRef.current) return;
    simliAttemptedRef.current = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return;
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, preferCurrentTab: true });
      stream.getVideoTracks().forEach((t) => t.stop()); // only the audio drives Simli
      const track = stream.getAudioTracks()[0];
      if (!track) { stream.getTracks().forEach((t) => t.stop()); return; }
      narrationStreamRef.current = stream;
      track.addEventListener('ended', () => { narrationStreamRef.current = null; setLiveNarration(false); });
      pendingAudioTrackRef.current = track;
      setSimliFailed(false);
      setLiveNarration(true);
    } catch {
      // Denied, cancelled, or unsupported — silently keep the static photo.
    }
  }

  // Fires once <SimliAvatar> actually mounts (right after ensureLiveAvatar
  // sets liveNarration true) and hands it the audio track we already have.
  useEffect(() => {
    if (!liveNarration || !simliRef.current || !pendingAudioTrackRef.current) return;
    const track = pendingAudioTrackRef.current;
    pendingAudioTrackRef.current = null;
    simliRef.current.start(track, simliFaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveNarration]);

  async function speakWithMouth(text, {
    onEnd, driveBoard, charOffset = 0, fullLen,
  } = {}) {
    setSpeaking(true);
    interruptedRef.current = false;
    if (mouthTimer.current) clearInterval(mouthTimer.current);
    mouthTimer.current = setInterval(() => setMouth((v) => !v), 220);
    const textLen = fullLen ?? (text || '').length;
    const nSteps = driveBoard ? steps.length : 0;
    if (driveBoard && charOffset === 0) setRevealed(nSteps > 0 ? 1 : 0);

    // Chrome's SpeechSynthesisUtterance "boundary" event doesn't fire at all
    // for some network voices (confirmed: zero boundary events over a full
    // utterance with the "Google US English" voice) — so board reveal and
    // the pause/resume position are estimated from elapsed time as the
    // primary driver. If boundary events *do* fire on a given browser/voice,
    // they still update the same ref with a (more accurate) value.
    const CHARS_PER_MS = 0.0152; // ~160 wpm at the utterance's rate (0.97)
    const startedAt = Date.now();
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
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
      onEnd: () => {
        if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
        if (mouthTimer.current) { clearInterval(mouthTimer.current); mouthTimer.current = null; }
        setSpeaking(false); setMouth(false);
        const wasInterrupted = interruptedRef.current;
        interruptedRef.current = false;
        if (driveBoard && !wasInterrupted) { setRevealed(nSteps); lastCharRef.current = textLen; }
        if (onEnd) onEnd();
      },
    });
    if (!speechSupported()) {
      if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
      if (mouthTimer.current) { clearInterval(mouthTimer.current); mouthTimer.current = null; }
      setSpeaking(false); setMouth(false);
      if (driveBoard) { setRevealed(nSteps); lastCharRef.current = textLen; }
      if (onEnd) onEnd();
    }
  }

  function play() {
    if (!segment) return;
    setShowCheck(false);
    if (simliFaceId) ensureLiveAvatar();
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
      <div className="topbar">
        <div className="crumb"><b>{course.title}</b><span>·</span><span className="mod">{mod.title}</span></div>
        <button className="ghost" onClick={onExit}>← {ui.moduleList}</button>
      </div>

      <div className="split" ref={splitRef}>
        <div className="left-pane">
          <div className="stage">
            <div className="presenter">
              {simliFaceId && liveNarration && !simliFailed
                ? (
                  <SimliAvatar
                    ref={simliRef}
                    size={170}
                    onStatusChange={(s) => { if (s === 'error') setSimliFailed(true); }}
                  />
                )
                : <Avatar id={avatarId} mouth={mouth} state={avatarState} size={170} />}
              <div className={`badge ${(speaking || thinking) ? 'on' : ''}`}>
                {thinking ? ui.thinking : (speaking ? ui.speaking : (handUp ? ui.listening : presenterName))}
              </div>
            </div>

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
          </div>

          <div className="controls">
            <button className="tbtn" onClick={() => goSegment(seg - 1)} disabled={seg === 0} aria-label={ui.type}>⏮</button>
            <button className="tbtn play" onClick={togglePlay} aria-label={ui.play}>{speaking ? '⏸' : '▶'}</button>
            <button className="tbtn" onClick={() => goSegment(seg + 1)} disabled={isLast} aria-label={ui.next}>⏭</button>
            <div className="progress">
              <span>{`${ui.module} ${mod.order || ''} · ${seg + 1}/${mod.segments.length}`}</span>
              <div className="track"><i style={{ width: `${((seg + 1) / mod.segments.length) * 100}%` }} /></div>
            </div>
            <button className={`chip ${captionsOn ? 'on' : ''}`} onClick={() => setCaptionsOn((v) => !v)}>💬 {ui.captions}</button>
            {mod.check && <button className={`chip ${showCheck ? 'on' : ''}`} onClick={() => { stopAll(); setShowCheck((v) => !v); }}>🎯 {ui.knowledgeCheck}</button>}
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
          <h2>{ui.choosePresenter}</h2>
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
          <button className="primary" onClick={() => setView('modules')}>{ui.continue}</button>
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
