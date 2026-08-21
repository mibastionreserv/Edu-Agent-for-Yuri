import React, {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { api, getToken, setToken, fetchTtsAudio } from './api.js';
import * as ttsCircuit from './ttsCircuit.js';
import { avatarSVG } from './avatar.js';
import SimliAvatar from './SimliAvatar.jsx';
import TavusAvatar from './TavusAvatar.jsx';
import Board from './Board.jsx';
import KnowledgeCheck from './KnowledgeCheck.jsx';
import {
  speak, cancelSpeech, pickVoiceInfo, speechSupported, langTag,
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
// 'amara' stays as an alias so previously saved progress (avatar_id) keeps
// working — the persona is now presented as Yuri, matching the male Tavus
// stock replica (r92debe21318) that actually renders the live video.
const TAVUS_PERSONAS = { yuri: true, amara: true };

// The server-TTS voice each persona speaks with. One voice per presenter,
// used for EVERY line she says — lesson narration, the resume phrase, Q&A
// answers — so a persona always sounds like herself. The cache is keyed on
// (text + voice + model), so each persona's audio is stored separately and
// switching presenter never serves another one's recording.
//
// Mira keeps Gacrux: it was the single hardcoded voice until now, so her
// existing cache entries stay valid instead of being re-synthesized.
// (Tavus personas are absent on purpose — Tavus does its own TTS.)
const PERSONA_TTS_VOICE = {
  mira: 'Gacrux', // warm, measured — the default coach
  daniel: 'Charon', // lower, informative male
  meilin: 'Leda', // brighter, energetic female
};
const DEFAULT_TTS_VOICE = 'Gacrux';

// Gender of each persona's voice — used to steer the browser Web Speech
// fallback (speech.js pickVoice) toward a voice that at least matches, so a
// fallback for Daniel and one for Mei-Lin don't both collapse onto the same
// system voice (SS-12).
// yuri/amara: Tavus does its own TTS (see PERSONA_TTS_VOICE above), but this
// map is also consulted by the Web Speech fallback used if the Tavus
// connection itself fails (see isTavus branch in speakWithMouth) — without
// an entry here that fallback silently defaulted to 'female' for Yuri, the
// male persona (SS-34).
const PERSONA_GENDER = {
  mira: 'female', daniel: 'male', meilin: 'female', yuri: 'male', amara: 'male',
};

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
// Named export (alongside the default App below) so tests can render the
// Q&A/presenter panel in isolation without driving the whole login/course
// picker flow (SS-30/SS-31 regression tests).
export function Classroom({
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
  // Synchronous latch alongside `asking` (SS-30): the `asking` state's
  // disabled={} only takes effect after React commits, so several clicks
  // fired in the same task (or Enter/voice, neither of which even checks
  // `asking`) can all read the same stale false before the first commit.
  const askingRef = useRef(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceReplies, setVoiceReplies] = useState(true);
  // Off by default per SRS §UI — captions are opt-in via the caption chip,
  // not shown automatically.
  const [captionsOn, setCaptionsOn] = useState(false);
  const [showCheck, setShowCheck] = useState(false);
  // Three-way, not the old two-valued voiceName string (SS-23): 'pending'
  // (the browser's voice list hasn't actually loaded yet — up to ~700ms via
  // 'voiceschanged', see speech.js loadVoices()) is a distinct state from
  // 'none' (the list DID load and genuinely has no match for this
  // language), so the UI never shows both "…(fallback)" and "no fallback
  // voice found" at once.
  const [voiceInfo, setVoiceInfo] = useState({ status: 'pending', name: '' });
  const [paused, setPaused] = useState(false);
  const [simliFailed, setSimliFailed] = useState(false);
  const [tavusFailed, setTavusFailed] = useState(false);
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
  // Guaranteed-continue timer for resume()'s bridge phrase (Web Speech's
  // 'end' event is not fully reliable) — kept in a ref so a later
  // pause/stop/resume can cancel it before it fires over new state.
  const resumeTimerRef = useRef(null);

  // Live Simli video avatar: always mounted for these personas — the
  // classroom presenter is exclusively the service-rendered video (SRS
  // FR-AV-5), connected via pre-warm the moment the classroom opens.
  // This presenter's server-TTS voice — the single voice used for every
  // line she speaks, and part of the cache key so it is stored per persona.
  const ttsVoice = PERSONA_TTS_VOICE[avatarId] || DEFAULT_TTS_VOICE;
  const personaGender = PERSONA_GENDER[avatarId] || 'female';

  const simliFaceId = SIMLI_FACES[avatarId];
  const simliRef = useRef(null);
  const simliAttemptedRef = useRef(false);
  // True once the Simli connection has actually reported 'live' — used to
  // decide whether narration still needs to wait (and show the blocking
  // loader) or can start instantly against the already-connected avatar.
  const simliUpRef = useRef(false);
  // True once Simli's onReady has fired at all (success OR failure) — the
  // latch that stops the blocking loader from reappearing on every later
  // line once the connection's outcome is already known. Symmetric to
  // photoTtsWarmedRef for photo personas, whose "warmed" latch never
  // un-warms after a failed line either (SS-33).
  const simliSettledRef = useRef(false);
  const recognitionRef = useRef(null);
  const voiceModeRef = useRef(false);

  // Live Tavus video avatar (Amara): connecting is async and Tavus is the
  // *only* audio source for this persona, so the first speak has to await a
  // real connection before it can say anything (see ensureTavusAvatar).
  const isTavus = Boolean(TAVUS_PERSONAS[avatarId]);
  const tavusRef = useRef(null);
  const tavusReadyRef = useRef(null); // Promise<boolean>, set once connecting starts
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
    return () => {
      alive = false; stopAll();
      // The presenter-dock subtree (SimliAvatar/TavusAvatar + narration
      // <audio>) is torn down and rebuilt for the new lang/module, but
      // Classroom itself is not remounted — these latches belong to the OLD
      // avatar instance and must not be inherited by the new one, or
      // ensureLiveAvatarFromElement()/ensureTavusAvatar() hands back an
      // already-resolved promise for a connection that no longer exists
      // (SS-10, and its Tavus-side repeat, SS-29).
      simliConnectReadyRef.current = null;
      simliAttemptedRef.current = false;
      simliUpRef.current = false;
      simliSettledRef.current = false;
      tavusReadyRef.current = null;
      // tavusStoppedResolveRef is NOT reset here: stopAll() above already
      // resolves and nulls it (via stopSpeechRef.current()) whenever a Tavus
      // utterance was in flight, and it is otherwise always null between
      // speakViaTavus() calls — nothing stale to inherit.
      // avatarConnecting/photoTtsWarmedRef belong to this same OLD instance
      // too — an overlay or "already warmed" latch left over from it must
      // not bleed into the freshly (re)connecting one (SS-31).
      setAvatarConnecting(false);
      photoTtsWarmedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleId, lang]);

  useEffect(() => { setRevealed(0); setShowCheck(false); return stopAll; /* eslint-disable-next-line */ }, [seg, mod]);

  useEffect(() => {
    let alive = true;
    if (!speechSupported()) { setVoiceInfo({ status: 'none', name: '' }); return () => { alive = false; }; }
    setVoiceInfo({ status: 'pending', name: '' });
    pickVoiceInfo(lang, personaGender).then((info) => { if (alive) setVoiceInfo(info); });
    return () => { alive = false; };
    // A persona swap without a Classroom remount (personaGender) must also
    // re-resolve the fallback voice, not just a language change (SS-23).
  }, [lang, personaGender]);

  // Watchdog: whichever code path raised the "connecting" overlay (Simli/
  // Tavus pre-warm, a server-TTS fetch) is expected to clear it itself once
  // it settles — but an unclassified/hung failure must not leave "Loading
  // the presenter…" on screen forever (SS-31). One generic timer, keyed off
  // the state itself, covers every call site instead of duplicating one at
  // each of them.
  useEffect(() => {
    if (!avatarConnecting) return undefined;
    const t = setTimeout(() => setAvatarConnecting(false), 7000);
    return () => clearTimeout(t);
  }, [avatarConnecting]);

  // Hard stop: cancels speech outright and forgets any resume position. Used
  // for segment navigation and unmount — a real "leave this moment" action,
  // unlike pauseNarration() which deliberately remembers where it stopped.
  function stopAll() {
    interruptedRef.current = true;
    speechGenRef.current += 1;
    if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
    if (mouthTimer.current) { clearInterval(mouthTimer.current); mouthTimer.current = null; }
    if (resumeTimerRef.current) { clearTimeout(resumeTimerRef.current); resumeTimerRef.current = null; }
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
    if (resumeTimerRef.current) { clearTimeout(resumeTimerRef.current); resumeTimerRef.current = null; }
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

  // The hidden <audio> element (rendered near the presenter, below) that
  // plays our own server-synthesized narration. Its captureStream() is what
  // actually drives Simli — no browser permission prompt needed for that,
  // unlike capturing the whole tab.
  const narrationAudioRef = useRef(null);

  // Live Simli connection state. The heavy lifting (transport, audio
  // routing, muting local playback) lives in SimliAvatar — see the rewrite
  // note there. Here we only cache the one connect attempt per lesson and
  // remember whether it succeeded.
  const simliConnectReadyRef = useRef(null);
  const simliConnectResolveRef = useRef(null);
  // Photo personas (Mira, Daniel): the mouth overlay is driven by a loudness
  // envelope decoded from the narration audio, written to a CSS variable on
  // the presenter dock (no React re-renders at 60fps).
  const presenterDockRef = useRef(null);
  // AudioContext used ONLY to decode narration audio into that envelope —
  // playback itself never goes through it, so a suspended context can't
  // silence the lesson. (It is still resumed on the Play gesture because
  // decodeAudioData is cheaper on a running context.)
  const narrationCtxRef = useRef(null);
  // True once the first TTS line for a photo persona has been fetched —
  // the full-screen loader is shown only for that first load, mirroring how
  // live avatars show it only for their first connect.
  const photoTtsWarmedRef = useRef(false);
  // Whether server TTS is currently usable is owned by ttsCircuit.js (a
  // module-level circuit breaker, not component state — see SS-20): a 429
  // opens it for a bounded, escalating backoff so one rate-limit blip
  // doesn't strand the rest of the lesson on the browser voice, while a
  // genuinely permanent failure (401/403/"not configured") opens it for the
  // whole session. `ttsDown` mirrors its status in React state purely so the
  // "🗣 Voice" indicator can react to it (refs/module state don't trigger a
  // re-render on their own) — SS-4.
  const [ttsDown, setTtsDown] = useState(() => ttsCircuit.state().status !== 'closed');
  // A single line can fall back to the browser voice without the circuit
  // ever opening (a transient failure — 5xx/no-audio/network blip — never
  // trips it, see ttsCircuit.js's SS-12 note), so `ttsDown` alone isn't
  // enough to know the "🗣 Voice" indicator's ttsVoice label is still
  // accurate; this tracks whether the browser voice has genuinely spoken.
  const [webSpeechUsed, setWebSpeechUsed] = useState(false);
  function noteTtsSuccess() { ttsCircuit.recordSuccess(); setTtsDown(false); }
  // Returns the failure's classification ('permanent' | 'rate-limit' |
  // 'transient') so callers can also decide whether an inline retry is
  // worth it — never for the first two (see ttsCircuit.js).
  function noteTtsFailure(err) {
    const kind = ttsCircuit.recordFailure(err);
    setTtsDown(ttsCircuit.state().status !== 'closed');
    return kind;
  }
  // The real per-attempt gate (mutating — see ttsCircuit.canAttempt(),
  // grants exactly one half-open probe once the cooldown elapses). Used ONLY
  // at the actual attempt site below, never speculatively.
  function canAttemptTts() { return ttsCircuit.canAttempt(); }
  // Coarse, non-mutating "is it even worth trying" check for deciding
  // whether to voice a Q&A answer at all — reading state() here instead of
  // calling canAttemptTts() means this check doesn't itself consume the one
  // permitted half-open probe that the real attempt (inside speakWithMouth)
  // reserves.
  function ttsMaybeAvailable() { return ttsCircuit.state().status !== 'open'; }

  // Hands the narration <audio> element to SimliAvatar and resolves once the
  // avatar is genuinely on screen (or failed). Only ever attempts once per
  // lesson. The element may have no src yet — that is fine, Simli reads its
  // samples as they start flowing.
  function ensureLiveAvatarFromElement(el) {
    if (!simliFaceId) return Promise.resolve(false);
    if (simliConnectReadyRef.current) return simliConnectReadyRef.current;
    simliConnectReadyRef.current = new Promise((resolve) => {
      if (simliAttemptedRef.current || !simliRef.current) { resolve(false); return; }
      simliAttemptedRef.current = true;
      simliConnectResolveRef.current = resolve; // settled from onReady below
      simliRef.current.start(el);
    });
    return simliConnectReadyRef.current;
  }

  // Starts the Tavus connection (once) and returns a promise resolving true
  // once actually connected. <TavusAvatar> is ALWAYS mounted for Tavus
  // personas, so the ref is available from the first render — start() is
  // called directly, with no mount-and-wait-for-effect dance (the previous
  // setState→remount→effect chain silently never fired on production,
  // leaving the loader up forever and the conversation never created).
  function ensureTavusAvatar() {
    if (!isTavus || !tavusRef.current) return Promise.resolve(false);
    if (tavusReadyRef.current) return tavusReadyRef.current;
    tavusReadyRef.current = tavusRef.current.start()
      .then((conversationId) => Boolean(conversationId));
    return tavusReadyRef.current;
  }

  // Pre-warm the live avatar the moment the classroom opens (SRS FR-FLOW-0 /
  // FR-AV-5/8): the connection cost is paid once, up front, behind the
  // blocking loader — so when narration actually starts there is no avatar
  // delay at all, and the learner only ever sees the service-rendered live
  // video, never a static stand-in. Applies to both providers.
  //
  // MUST be keyed on `loading`, not run on mount: while the module is still
  // loading the component early-returns a spinner, so the avatar components
  // (and narrationAudioRef) do not exist yet — a mount-time pre-warm found
  // null refs, silently did nothing, and the avatar never connected (the
  // production "Connecting… forever, no conversation ever created" bug).
  // Decide the voice for the WHOLE lesson up front, before a single line is
  // spoken. Lesson paragraphs are usually cache hits (no quota cost) while
  // the interstitial phrases and Q&A answers are fresh text — so without
  // this probe the presenter would start in the server voice and switch to
  // the browser voice the moment it hit an uncached line, which is exactly
  // the mid-lesson voice change that kept being reported. Probing the
  // resume phrase is free when it is cached and, when it is not, both warms
  // the cache and reveals an unavailable TTS before anything is spoken.
  useEffect(() => {
    if (loading || !mod || isTavus || !canAttemptTts()) return;
    const probe = ui.resumeAfterQuestion || 'Let us continue.';
    let alive = true;
    fetchTtsAudio(probe, ttsVoice, { languageCode: langTag(lang), gender: personaGender.toUpperCase() })
      .then(() => { if (alive) noteTtsSuccess(); })
      .catch((e) => { if (alive) noteTtsFailure(e); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  useEffect(() => {
    if (loading || !mod) return;
    if (simliFaceId) {
      const el = narrationAudioRef.current;
      if (!el) return;
      setAvatarConnecting(true);
      // Single timeout for this handshake lives inside SimliAvatar
      // (CONNECT_TIMEOUT_MS) — no separate race here, or a lost race could
      // report "failed" over a connection that is still live (SS-1). Muting
      // on failure is owned entirely by SimliAvatar's onReady callback below.
      ensureLiveAvatarFromElement(el).then((ok) => {
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
  }, [loading]);

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
        // Cap below the very end: this is a time-based ESTIMATE, and if it
        // overshoots while speech is still running, an interrupted segment
        // looks 'already finished' and cannot be resumed from its real spot.
        // Only a natural finish() marks the text as fully spoken.
        lastCharRef.current = Math.max(lastCharRef.current, Math.min(estAbs, textLen * 0.97));
        setRevealed((r) => Math.max(r, revealedFromProgress(lastCharRef.current, textLen, nSteps)));
      }, 200);
    }

    tavusRef.current.sendText(text);
    setSpeaking(true); // real speech, not just the connection, starts here (SS-31)
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
    // No photo landmarks means Avatar renders the drawn SVG (either the
    // photo 404'd, e.g. course-content/avatars/daniel.jpg is missing, or the
    // persona was never photographed) — its mouth is a boolean prop with no
    // amplitude-driven overlay to follow, so it needs the blink below (SS-8).
    const svgMouthBlink = !simliFaceId && !PHOTO_LANDMARKS[avatarId];

    // The connection itself is normally already up — it's pre-warmed on
    // classroom mount (see the effect above). Awaiting the cached promise is
    // then instant; the overlay only appears in the rare case the pre-warm
    // hasn't finished (or was skipped) by the time narration starts. Photo
    // personas get the same blocking loader while their FIRST voice line is
    // being synthesized, so the learner never watches a silent, motionless
    // (or worse, twitching) photo waiting for audio.
    const photoOverlay = !simliFaceId && !photoTtsWarmedRef.current;
    // Once Simli's outcome is known (simliSettledRef), don't raise the
    // blocking loader again on later lines just because it never reached
    // 'live' — a permanently failed connection must not re-block every
    // subsequent line for the rest of the lesson (SS-33).
    const showOverlay = (Boolean(simliFaceId) && !simliUpRef.current && !simliSettledRef.current) || photoOverlay;
    if (showOverlay) setAvatarConnecting(true);
    // No separate race/timeout here — SimliAvatar's own CONNECT_TIMEOUT_MS is
    // the single timeout for this handshake (SS-1: duplicate timeouts caused
    // a "failed" result to land over a connection that was still live).
    const simliPromise = simliFaceId ? ensureLiveAvatarFromElement(el) : null;

    const ttsLangGender = { languageCode: langTag(lang), gender: personaGender.toUpperCase() };
    let blob = null;
    try {
      blob = await fetchTtsAudio(text, ttsVoice, ttsLangGender);
    } catch (firstErr) {
      // A rate-limit or auth/config failure opens the circuit (bounded
      // backoff for 429, the whole session for a real permanent failure —
      // see ttsCircuit.js) — retrying only this line, or any later one
      // before it reopens, is pointless, and for 429 specifically it's
      // actively harmful, burning more of the quota we just ran out of.
      // Everything else (5xx, no-audio, timeout, network blip) is a one-off
      // flake — fall back to the browser voice for THIS line only, the next
      // line still tries server TTS (SS-12).
      if (noteTtsFailure(firstErr) !== 'transient') {
        photoTtsWarmedRef.current = true;
        if (showOverlay) setAvatarConnecting(false);
        if (presenterDockRef.current) presenterDockRef.current.removeAttribute('data-lipsync');
        return false;
      }
      // One client-side retry on top of the server's own retries: falling
      // back to Web Speech means the live avatar cannot lip-sync at all
      // (its track only carries this element's audio), so a second attempt
      // is well worth ~a second of extra wait.
      await new Promise((r) => { setTimeout(r, 800); });
      if (myGen !== speechGenRef.current) {
        if (showOverlay) setAvatarConnecting(false);
        return true; // stale — a newer line took over; drop silently
      }
      try {
        blob = await fetchTtsAudio(text, ttsVoice, ttsLangGender);
      } catch (secondErr) {
        noteTtsFailure(secondErr);
        photoTtsWarmedRef.current = true; // don't re-show the loader per line
        if (showOverlay) setAvatarConnecting(false);
        // Web Speech takes over — let the blink fallback animate the mouth,
        // since there's no audio stream to drive it from.
        if (presenterDockRef.current) presenterDockRef.current.removeAttribute('data-lipsync');
        return false;
      }
    }
    noteTtsSuccess();
    photoTtsWarmedRef.current = true;
    const objectUrl = URL.createObjectURL(blob);

    // Photo personas: precompute a loudness envelope from the decoded WAV
    // so the mouth can follow the real voice WITHOUT touching the audio
    // element's output path. (Routing the element through
    // createMediaElementSource would hand its audio to Web Audio — if that
    // context is ever suspended by autoplay policy, the learner hears
    // nothing at all. Decoding a copy is risk-free: playback stays plain
    // and always audible.)
    let envelope = null;
    const ENV_FPS = 60;
    if (!simliFaceId) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          const ctx = narrationCtxRef.current || new Ctx();
          narrationCtxRef.current = ctx;
          const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
          const ch = buf.getChannelData(0);
          const per = Math.max(1, Math.floor(buf.sampleRate / ENV_FPS));
          const out = new Float32Array(Math.ceil(ch.length / per));
          for (let i = 0; i < out.length; i += 1) {
            let sum = 0;
            const start = i * per;
            const end = Math.min(start + per, ch.length);
            for (let j = start; j < end; j += 1) sum += ch[j] * ch[j];
            const rms = Math.sqrt(sum / Math.max(1, end - start));
            out[i] = Math.max(0, Math.min(1, (rms - 0.015) * 8));
          }
          envelope = out;
        }
      } catch { /* no envelope — the gentle speaking bob still applies */ }
      if (myGen !== speechGenRef.current) {
        if (showOverlay) setAvatarConnecting(false);
        URL.revokeObjectURL(objectUrl);
        return true;
      }
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
      // The onReady callback (SimliAvatar prop, above) is the single owner
      // of el.muted and of tearing the connection down on failure — this
      // just reacts to the same resolved value for local bookkeeping.
      // A hard upper bound on top of SimliAvatar's own CONNECT_TIMEOUT_MS:
      // if simliPromise never settles at all (e.g. a start()/onReady defect
      // — see SS-33), this line must still get spoken instead of hanging
      // forever behind the loader.
      const ok = await Promise.race([
        simliPromise,
        new Promise((resolve) => { setTimeout(() => resolve(false), 3000); }),
      ]);
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

    // Amplitude-driven mouth for photo personas: sample the analyser every
    // frame and write the level into a CSS variable on the presenter dock —
    // the mouth overlay's scaleY follows the actual loudness of the voice.
    let mouthRafId = null;
    const dockEl = presenterDockRef.current;
    const stopMouthLoop = () => {
      if (mouthRafId) { cancelAnimationFrame(mouthRafId); mouthRafId = null; }
      if (dockEl) dockEl.style.setProperty('--mouth', '0');
    };
    if (!simliFaceId && envelope && dockEl) {
      dockEl.setAttribute('data-lipsync', '1');
      const tick = () => {
        // Read the precomputed loudness at the element's real playback
        // position — perfectly in step with what the learner hears.
        const idx = Math.floor(el.currentTime * ENV_FPS);
        const level = idx >= 0 && idx < envelope.length ? envelope[idx] : 0;
        dockEl.style.setProperty('--mouth', level.toFixed(3));
        mouthRafId = requestAnimationFrame(tick);
      };
      mouthRafId = requestAnimationFrame(tick);
    }

    // Reuses the same stopSpeechRef mechanism pauseNarration()/stopAll()
    // already call for the Web Speech path — no changes needed there.
    stopSpeechRef.current = () => {
      stopMouthLoop();
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
      // The Web Audio context the element is routed through may still be
      // suspended (autoplay policy) — resume alongside play(); both calls
      // descend from the same user interaction chain.
      if (narrationCtxRef.current && narrationCtxRef.current.state === 'suspended') {
        narrationCtxRef.current.resume().catch(() => {});
      }
      await el.play();
      // Voice is actually flowing now — drop the first-load overlay and (for
      // photo personas) turn on the gentle speaking bob; the mouth itself is
      // driven by the amplitude loop, not by this flag. This is also where
      // `speaking` itself turns true (SS-31) — see speakWithMouth.
      setSpeaking(true);
      if (photoOverlay) setAvatarConnecting(false);
      if (!simliFaceId) {
        // Personas with no photo (and so no --mouth-driven .ap-mouth overlay
        // to follow the envelope, e.g. Daniel) fall back to the drawn SVG,
        // whose mouth is a plain boolean prop — blink it like the Web Speech
        // fallback does, or it just sits statically open for the whole line
        // (SS-8). Photo personas keep the single setMouth(true): their mouth
        // is actually driven by the amplitude loop above.
        if (svgMouthBlink) {
          if (mouthTimer.current) clearInterval(mouthTimer.current);
          mouthTimer.current = setInterval(() => setMouth((v) => !v), 220);
        } else {
          setMouth(true);
        }
      }
    } catch {
      // Autoplay blocked or similar — fall back to Web Speech for this line.
      if (showOverlay) setAvatarConnecting(false);
      stopMouthLoop();
      if (dockEl) dockEl.removeAttribute('data-lipsync'); // let the blink fallback show
      if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
      el.removeEventListener('ended', onEnded);
      stopSpeechRef.current = null;
      URL.revokeObjectURL(objectUrl);
      return false;
    }
    await done;
    stopMouthLoop();
    URL.revokeObjectURL(objectUrl);
    finish();
    return true;
  }

  async function speakWithMouth(text, {
    onEnd, driveBoard, charOffset = 0, fullLen,
  } = {}) {
    const myGen = ++speechGenRef.current;
    // `speaking` itself is NOT raised here anymore (SS-31): it used to fire
    // before any of the three playback paths below had actually produced
    // sound, so a TTS fetch stuck on the 25-30s budget/timeout left the
    // "Speaking" badge (and the pause icon) on for that whole stretch with
    // no audio playing. Each path now sets it once real playback starts.
    interruptedRef.current = false;
    // NOTE: the 220ms mouth blink is NOT started here anymore — it made the
    // photo twitch while the TTS audio was still loading, before any sound.
    // The amplitude loop drives the mouth on the server-TTS path; the blink
    // only starts below, together with the Web Speech fallback actually
    // speaking.
    if (mouthTimer.current) clearInterval(mouthTimer.current);
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
      // onEnd (e.g. resume()'s continueLesson) must only fire on a genuine,
      // un-interrupted finish of THIS speech generation — otherwise cutting
      // off the "let's continue" bridge phrase (raise hand / pause again
      // while it's talking) silently resumes the lesson on its own (SS-2).
      if (onEnd && !wasInterrupted && myGen === speechGenRef.current) onEnd();
    };

    // Everyone except Tavus personas gets real, server-synthesized speech:
    // Simli personas need it as the lip-sync audio source, and photo
    // personas (Mira, Daniel) use the same audio to drive the amplitude-
    // based mouth — plus a far better voice than the browser's.
    //
    // Server TTS is preferred (better voice, and it's the only audio a live
    // avatar can lip-sync to). speakViaServerTts() itself decides whether a
    // failure opens the ttsCircuit (a bounded backoff for a 429, the whole
    // session for a real permanent failure — SS-20) or is just this one line
    // flaking (5xx, no-audio, timeout), in which case the circuit stays
    // closed and the very next line tries the server again instead of the
    // whole rest of the lesson being stuck on the browser voice (SS-12).
    if (!isTavus && canAttemptTts()) {
      const handled = await speakViaServerTts(text, {
        charOffset, textLen, driveBoard, nSteps, finish, myGen,
      });
      if (handled) return;
      if (myGen !== speechGenRef.current) return; // superseded while we tried
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

    // Web Speech fallback from here on — the coarse 220ms blink is the only
    // available mouth animation (no audio stream to measure), started only
    // now, when the fallback is actually about to speak.
    mouthTimer.current = setInterval(() => setMouth((v) => !v), 220);

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
        // Cap below the very end: this is a time-based ESTIMATE, and if it
        // overshoots while speech is still running, an interrupted segment
        // looks 'already finished' and cannot be resumed from its real spot.
        // Only a natural finish() marks the text as fully spoken.
        lastCharRef.current = Math.max(lastCharRef.current, Math.min(estAbs, textLen * 0.97));
        setRevealed((r) => Math.max(r, revealedFromProgress(lastCharRef.current, textLen, nSteps)));
      }, 200);
    }

    stopSpeechRef.current = await speak(text, lang, {
      // The utterance's real 'start' event (SS-31) — not speak()'s own
      // resolution, which only means the call was handed to speechSynthesis.
      onStart: () => { setSpeaking(true); setWebSpeechUsed(true); },
      onBoundary: driveBoard ? (ci) => {
        const abs = charOffset + ci;
        lastCharRef.current = Math.max(lastCharRef.current, abs);
        setRevealed((r) => Math.max(r, revealedFromProgress(lastCharRef.current, textLen, nSteps)));
      } : undefined,
      onEnd: finish,
      gender: personaGender,
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
    // Resuming the decode context needs a user gesture, so it happens
    // synchronously here. Wrapped defensively: a throw anywhere in this
    // handler would silently kill the Play button for the whole lesson,
    // which is exactly how a missing-reference regression once made Play
    // look "broken" with no visible error.
    try {
      if (narrationCtxRef.current && narrationCtxRef.current.state === 'suspended') {
        narrationCtxRef.current.resume().catch(() => {});
      }
    } catch { /* decode context is optional — never block playback on it */ }
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
  // Lowering the hand: the presenter acknowledges that the Q&A is over and
  // says she's picking the lesson back up, then narration continues from
  // exactly where it was interrupted (SRS FR-FLOW-9) — instead of silently
  // jumping back mid-sentence.
  function resume() {
    stopVoiceMode();
    setHandUp(false);

    // A previous resume() call's guarantee timer must not fire over this
    // one's state (SS-2) — an orphaned 12s timer from an earlier hand-raise
    // could otherwise call continueLesson() long after the learner moved on.
    if (resumeTimerRef.current) { clearTimeout(resumeTimerRef.current); resumeTimerRef.current = null; }

    // Snapshot WHERE to continue right now, before anything else speaks.
    // Reading these refs after the bridge phrase finished was the bug: by
    // then the interstitial speech had moved the shared position state on,
    // so resuming silently found nothing left to say and the lesson just
    // stopped after promising to continue.
    const full = fullTextRef.current;
    const from = lastCharRef.current;

    // Whatever is still speaking (the raise-hand prompt, an answer) must be
    // cut off first — otherwise the bridge queues behind it and the learner
    // sits through several seconds of silence before anything happens.
    if (stopSpeechRef.current) { stopSpeechRef.current(); stopSpeechRef.current = null; }
    cancelSpeech();

    let resumed = false;
    const continueLesson = () => {
      if (resumed) return;
      resumed = true;
      setPaused(false);
      // The remembered position is only an ESTIMATE while the browser voice
      // is used (Web Speech reports no reliable progress), so it can run
      // past the real end of the text. In that case replay this segment
      // from the top: never jump to another segment (that skips content and
      // only clears the board) and never fall silent.
      if (!full || from >= full.length) { play(); return; }
      speakWithMouth(full.slice(from), {
        driveBoard: true, charOffset: from, fullLen: full.length,
      });
    };

    const bridge = ui.resumeAfterQuestion;
    if (!bridge) { continueLesson(); return; }
    // Continue when the bridge ends, and guarantee it with a timer too:
    // Web Speech drops 'end' often enough (backgrounded tab, interrupted
    // utterance, some network voices) that the callback alone is not
    // dependable. continueLesson is idempotent, so both paths are safe.
    speakWithMouth(bridge, { driveBoard: false, onEnd: continueLesson });
    resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; continueLesson(); }, 12000);
  }

  async function submitQuestion(text, viaVoice = false) {
    const q = (text ?? question).trim();
    if (!q) return;
    if (askingRef.current) return;
    askingRef.current = true;
    if (!handUp) { pauseNarration(); setHandUp(true); }
    const history = threadRef.current
      .filter((m) => m.role === 'learner' || (m.role === 'presenter' && m.topicality))
      .map((m) => ({ role: m.role, text: m.text }));
    setThread((t) => [...t, { role: 'learner', text: q, viaVoice }]);
    setQuestion(''); setAsking(true); setThinking(true);
    try {
      const res = await api.ask({ moduleId, lang, question: q, history, askedByVoice: viaVoice, avatarId });
      setThinking(false);
      setThread((t) => [...t, {
        role: 'presenter',
        text: res.answer,
        topicality: res.topicality,
        source: res.source,
        sources: res.sources,
        certainty: res.certainty,
      }]);
      // Real playback for this line goes through server TTS (or Tavus) via
      // speakWithMouth, neither of which depends on Web Speech — only gate on
      // speechSupported() once the circuit is actually open, so the browser
      // fallback voice remains the true "can we speak at all?" check. This
      // is a coarse, non-consuming check (ttsMaybeAvailable), not the real
      // per-attempt gate — that one lives inside speakWithMouth itself.
      if ((viaVoice || voiceReplies) && (ttsMaybeAvailable() || speechSupported())) {
        speakWithMouth(res.answer, { driveBoard: false });
      }
    } catch (e) {
      setThinking(false);
      setThread((t) => [...t, { role: 'presenter', text: e.message || ui.errorGeneric, topicality: 'error' }]);
    } finally { askingRef.current = false; setAsking(false); }
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
  // "Listening" must track the mic actually being open (voiceMode), not just
  // a raised hand — handUp stays true well after an answer has finished
  // playing, which previously left the badge stuck on "Listening".
  const avatarState = thinking ? 'listening' : (voiceMode && !speaking ? 'listening' : 'idle');

  return (
    <div className="room">
      <div className="topbar">
        <div className="crumb"><b>{course.title}</b><span>·</span><span className="mod">{mod.title}</span></div>
        <button className="ghost" onClick={onExit}>← {ui.moduleList}</button>
      </div>

      <div className="split" ref={splitRef}>
        {/* Scoped to the lesson area only (not the topbar/appbar above) — a
            full-viewport overlay here used to swallow the first click on
            "← Modules" or the language switcher while it was up (SS-5). */}
        {avatarConnecting && (
          <div className="avatar-loading-overlay" role="alert" aria-live="assertive">
            <Spinner label={ui.avatarLoading || 'Loading the presenter…'} />
          </div>
        )}
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
            <div className="presenter-dock" ref={presenterDockRef}>
              {simliFaceId ? (
                /* Always mounted, even after a failed/slow connect: the
                   component shows the persona photo until real frames
                   arrive, so a late stream can still take over and the
                   learner never sees a black box. */
                <SimliAvatar
                  ref={simliRef}
                  faceId={simliFaceId}
                  size={150}
                  posterSrc={`/content/avatars/${avatarId}.jpg`}
                  onReady={(ok) => {
                    simliUpRef.current = ok;
                    simliSettledRef.current = true;
                    const el = narrationAudioRef.current;
                    if (ok) {
                      // Symmetric to the failure branch below: Simli's onReady
                      // is not monotonic (a timed-out attempt can still report
                      // success once real frames arrive), so any earlier
                      // unmute here must be undone or the line plays twice —
                      // once from Simli, once from the local element.
                      setSimliFailed(false);
                      if (el) el.muted = true;
                    } else {
                      setSimliFailed(true);
                      // Tear the connection down for good: without this, a
                      // late frame arriving after this "failure" would flip
                      // onReady(true) later while narration is already
                      // playing unmuted locally — the double-voice bug this
                      // guards against.
                      if (simliRef.current) simliRef.current.stop();
                      // Simli's listenToAudioElement mutes local playback so
                      // the voice is heard once, via Simli. If Simli isn't
                      // delivering after all, unmute or the lesson is silent.
                      if (el) el.muted = false;
                    }
                    if (simliConnectResolveRef.current) {
                      simliConnectResolveRef.current(ok);
                      simliConnectResolveRef.current = null;
                    }
                  }}
                />
              ) : isTavus ? (
                /* Tavus personas NEVER fall back to the 2D drawing — the
                   service-rendered live video is the only classroom
                   presenter; on connection problems TavusAvatar shows its
                   own error overlay instead (SRS FR-AV-5). */
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
                {thinking ? ui.thinking : (speaking ? ui.speaking : (voiceMode ? ui.listening : presenterName))}
              </div>
              {/* Hidden player for server-synthesized speech — for Simli
                  personas its Web Audio routing feeds the live avatar's
                  track; for photo personas it feeds the amplitude-driven
                  mouth analyser. Tavus personas don't use it: Tavus does its
                  own TTS server-side. */}
              {!isTavus && <audio ref={narrationAudioRef} style={{ display: 'none' }} />}
            </div>
          </div>

          <div className="controls">
            <button className="tbtn" onClick={() => goSegment(seg - 1)} disabled={avatarConnecting || seg === 0} aria-label={ui.prev}>⏮</button>
            <button className="tbtn play" onClick={togglePlay} disabled={avatarConnecting} aria-label={speaking ? ui.pause : ui.play}>{speaking ? '⏸' : '▶'}</button>
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
                {m.certainty === 'low' && <span className="src low-certainty">⚠ {ui.lowCertainty}</span>}
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
                  onKeyDown={(e) => e.key === 'Enter' && submitQuestion()}
                  disabled={asking} />
                <button className="primary sm" onClick={() => submitQuestion()} disabled={asking}>{ui.ask}</button>
              </div>
            ) : (
              <div className="voice">
                <span className="mic-live" aria-hidden="true" />
                <span className="hint">{ui.holdToTalk}</span>
              </div>
            )}
            {/* The real voice for every line (narration, resume phrase, Q&A
                answers) is this persona's server-TTS voice, not the browser's
                Web Speech voice — show that as the primary indicator, and
                only call out the browser fallback once it has actually been
                used (whole-session latch via `ttsDown`, SS-4, OR a single
                line that fell back without tripping the circuit at all —
                `webSpeechUsed`, see its declaration above). When either is
                true, voiceInfo.status distinguishes "still resolving"
                (pending) from "genuinely no match for this language" (none)
                — showing a placeholder fallback name AND "no fallback voice
                found" at the same time was the SS-23 bug; while it's still
                pending we show neither the "(fallback)" suffix nor the
                warning line, and we never show the server persona voice
                either (that was this ticket's bug: it named the wrong
                entity — a voice that isn't the one actually speaking). */}
            {!isTavus && ((ttsDown || webSpeechUsed) ? voiceInfo.status !== 'none' : true) && (
              <div className="voicename">
                🗣 {ui.voice}: {(ttsDown || webSpeechUsed)
                  ? (voiceInfo.status === 'ready' ? voiceInfo.name : '…')
                  : ttsVoice}
                {(ttsDown || webSpeechUsed) && voiceInfo.status === 'ready' && ' (fallback)'}
              </div>
            )}
            {(ttsDown || webSpeechUsed) && voiceInfo.status === 'none' && (
              <div className="voicename">{ui.voiceUnavailable || ''}</div>
            )}
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
  // Saved lang/avatar are restored exactly once, on the very first load —
  // this effect also re-runs on every later user-initiated language switch
  // (it depends on [lang]), and re-applying the saved values there would
  // silently stomp on a presenter/language the learner just picked (SS-7).
  const hydratedRef = useRef(false);

  async function loadAll(l) {
    setLoading(true); setError('');
    try {
      const [u, c] = await Promise.all([api.uiStrings(l), api.course(l)]);
      setUi(u); setCourse(c);
      try {
        const p = await api.getProgress();
        if (p) {
          if (!hydratedRef.current) {
            if (p.avatar_id) setAvatarId(p.avatar_id);
            // Applying a different saved language re-triggers this same
            // effect (it depends on [lang]) for a second, final pass — by
            // then hydratedRef.current is already true, so that pass does
            // not loop back here.
            if (p.lang && p.lang !== l) setLang(p.lang);
          }
          if (p.module_id) { setModuleId(p.module_id); setInitialSegment(p.segment_index || 0); }
        }
      } catch { /* no progress yet */ }
      hydratedRef.current = true;
      setLoading(false);
    } catch (e) { setError(e.message || 'Failed to load'); setLoading(false); }
  }
  useEffect(() => { loadAll(lang); /* eslint-disable-next-line */ }, [lang]);

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(''), 1800); }
  // Accepts overrides for whichever value just changed, since the caller's
  // own setState (setAvatarId/setLang/setInitialSegment) has not necessarily
  // committed yet when this reads the surrounding state (SS-7: presenter and
  // language choices are saved immediately, not only on segment navigation).
  // silent: skip the toast entirely. Needed for the language-change call
  // site below — `ui` here is a closure over the OLD language's strings,
  // and the new ones only arrive later via loadAll(), so an immediate
  // showToast(ui.saved) would flash the previous language's "Saved" text
  // (SS-14). Saving itself is unaffected either way.
  async function saveProgress({
    segment, avatar, language, silent,
  } = {}) {
    try {
      await api.saveProgress({
        courseId: COURSE_ID,
        moduleId,
        segmentIndex: segment ?? initialSegment,
        lang: language ?? lang,
        avatarId: avatar ?? avatarId,
      });
      if (!silent) showToast(ui.saved);
    } catch { if (!silent) showToast(ui.errorGeneric); }
  }

  if (loading || !ui) return <div className="shell"><Spinner label="Loading…" /></div>;

  return (
    <div className="shell">
      <header className="appbar">
        <div className="brand"><span className="glyph" /> <b>{ui.appName}</b></div>
        <div className="appbar-right">
          <div className="lang">
            {(course.supportedLanguages || ['en']).map((l) => (
              <button key={l} className={lang === l ? 'sel' : ''}
                onClick={() => { setLang(l); saveProgress({ language: l, silent: true }); }}>{l.toUpperCase()}</button>
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
              <button key={a.id} className={`acard ${avatarId === a.id ? 'sel' : ''}`}
                onClick={() => { setAvatarId(a.id); saveProgress({ avatar: a.id }); }}>
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
          onSaved={(nextSegment) => { setInitialSegment(nextSegment); saveProgress({ segment: nextSegment }); }}
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
