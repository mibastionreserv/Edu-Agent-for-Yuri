// Speech layer over the Web Speech API (browser-native, open, no API keys).
// It picks the most natural voice the browser offers for the selected language
// and degrades gracefully to text. For production-grade neural voices the
// pipeline can be pointed at an open-source engine (Piper / Coqui TTS) behind
// the backend without changing callers.

export function speechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// BCP-47 tags per supported language.
const LANG_TAG = { en: 'en-US', de: 'de-DE', it: 'it-IT', el: 'el-GR' };
export function langTag(lang) { return LANG_TAG[lang] || 'en-US'; }

let cachedVoices = [];
function loadVoices() {
  if (!speechSupported()) return Promise.resolve([]);
  const now = window.speechSynthesis.getVoices();
  if (now && now.length) { cachedVoices = now; return Promise.resolve(now); }
  return new Promise((resolve) => {
    const done = () => { cachedVoices = window.speechSynthesis.getVoices() || []; resolve(cachedVoices); };
    window.speechSynthesis.onvoiceschanged = done;
    setTimeout(done, 700);
  });
}

const GOOD = [/natural/i, /neural/i, /wavenet/i, /studio/i, /premium/i, /enhanced/i, /siri/i, /google/i];
const BAD = [/compact/i, /espeak/i, /robot/i];

function rank(voice, prefix) {
  let s = 0;
  const name = `${voice.name} ${voice.voiceURI || ''}`;
  const vlang = (voice.lang || '').toLowerCase().replace('_', '-');
  if (vlang.startsWith(prefix)) s += 10;
  else if (vlang.slice(0, 2) === prefix.slice(0, 2)) s += 6;
  if (GOOD.some((re) => re.test(name))) s += 5;
  if (BAD.some((re) => re.test(name))) s -= 6;
  if (voice.localService === false) s += 1;
  return s;
}

export async function pickVoice(lang) {
  const voices = await loadVoices();
  if (!voices.length) return null;
  const prefix = langTag(lang).toLowerCase();
  const scored = voices.map((v) => ({ v, s: rank(v, prefix) })).sort((a, b) => b.s - a.s);
  // Only return a voice that at least shares the language family, else null so
  // the browser default (which may not match) is not misused.
  return scored[0].s >= 6 ? scored[0].v : null;
}

export async function pickVoiceName(lang) {
  const v = await pickVoice(lang);
  return v ? v.name : null;
}

// Speak text with natural pacing. onBoundary(charIndex) fires as words are
// spoken so the caller can drive synchronized whiteboard cues. Returns cancel().
export async function speak(text, lang, {
  onStart, onEnd, onError, onBoundary,
} = {}) {
  if (!speechSupported() || !text) { if (onEnd) onEnd(); return () => {}; }
  const voice = await pickVoice(lang);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = langTag(lang);
  if (voice) u.voice = voice;
  u.rate = 0.97;
  u.pitch = 1.0;
  u.volume = 1.0;
  if (onStart) u.onstart = onStart;
  if (onBoundary) u.onboundary = (e) => { try { onBoundary(e.charIndex || 0); } catch { /* noop */ } };
  u.onend = () => onEnd && onEnd();
  u.onerror = () => { if (onError) onError(); else if (onEnd) onEnd(); };
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch { if (onEnd) onEnd(); }
  return () => { try { window.speechSynthesis.cancel(); } catch { /* noop */ } };
}

export function cancelSpeech() {
  if (speechSupported()) { try { window.speechSynthesis.cancel(); } catch { /* noop */ } }
}
