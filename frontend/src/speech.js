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

// Common voice names shipped by Windows/macOS/Chrome/Edge speechSynthesis.
// Not exhaustive, but covers the voices actually seen in the wild — enough
// to stop two personas of different genders from both falling back to the
// same system voice (SS-12), including "Google US English" (Chrome/Windows'
// most common default, unlabeled by itself — SS-34) and Edge's natural
// voices. The bare "male"/"female" words also catch "Google UK English
// Male/Female" and similar self-labeled voice names.
const MALE_NAME = /\b(david|guy|mark|daniel|thomas|male|george|james|alex|andrew|brian|christopher|eric|roger|steffan|fred|tom)\b/i;
const FEMALE_NAME = /\b(zira|susan|female|samantha|victoria|karen|hazel|catherine|eva|anna|ava|emma|jenny|michelle|aria|ana|sara|moira|tessa|google us english)\b/i;

function voiceGender(name) {
  if (MALE_NAME.test(name)) return 'male';
  if (FEMALE_NAME.test(name)) return 'female';
  return null;
}

// Gender is a hard filter + sort tier, never a scalar folded into the same
// sum as language/quality (SS-34): a "quality" bonus (e.g. +5 for a
// "google"-named voice) must never be able to outweigh a gender mismatch,
// which a single additive score allowed — that's exactly how a male persona
// used to end up speaking with "Google US English" over a real male voice.
// Tier 0 = voice's detected gender matches the requested one.
// Tier 1 = voice's gender could not be determined from its name (neutral).
// Opposite-gender voices are dropped as candidates entirely, not just
// down-ranked.
function genderTier(name, gender) {
  if (!gender) return 0;
  const g = voiceGender(name);
  if (g === gender) return 0;
  if (g === null) return 1;
  return 2;
}

function qualityScore(voice, prefix) {
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

function rankCandidates(voices, prefix, gender) {
  return voices
    .map((v) => ({ v, tier: genderTier(`${v.name} ${v.voiceURI || ''}`, gender), s: qualityScore(v, prefix) }))
    .filter((c) => c.tier < 2)
    .sort((a, b) => (a.tier - b.tier) || (b.s - a.s));
}

// Resolves the picked voice plus WHY there wasn't one, so speak() can tell
// "this language just has no installed voice at all" (pre-existing,
// harmless to hand to the browser's own lang-tag default) apart from "a
// voice for this language exists, but only in the opposite gender" — the
// latter (`blocked`) must never fall through to the browser default, since
// that default is exactly the wrong-gender voice being excluded (SS-34).
async function resolveVoice(lang, gender) {
  const voices = await loadVoices();
  if (!voices.length) return { voice: null, blocked: false, pending: true };
  const prefix = langTag(lang).toLowerCase();
  const scored = rankCandidates(voices, prefix, gender);
  if (scored.length && scored[0].s >= 6) return { voice: scored[0].v, blocked: false, pending: false };
  const blocked = Boolean(gender) && voices.some((v) => qualityScore(v, prefix) >= 6);
  return { voice: null, blocked, pending: false };
}

export async function pickVoice(lang, gender) {
  // Only returns a voice that at least shares the language family, else null
  // so the browser default (which may not match) is not misused.
  const { voice } = await resolveVoice(lang, gender);
  return voice;
}

// Distinguishes WHY there's no name yet, unlike pickVoiceName's old plain
// string ('' meant both "still resolving" and "genuinely no match" — SS-23):
//  - 'pending': the browser's voice list hasn't actually loaded yet (still
//    empty even after loadVoices()'s wait) — we don't know yet, so callers
//    must not claim "no fallback voice" off this.
//  - 'ready': the list loaded and a matching voice was found.
//  - 'none': the list REALLY loaded (a non-empty array) and nothing in it
//    matches this language — only now is "no fallback voice" a true claim.
export async function pickVoiceInfo(lang, gender) {
  const { voice, pending } = await resolveVoice(lang, gender);
  if (pending) return { status: 'pending', name: '' };
  return voice ? { status: 'ready', name: voice.name } : { status: 'none', name: '' };
}

// Speak text with natural pacing. onBoundary(charIndex) fires as words are
// spoken so the caller can drive synchronized whiteboard cues. Returns cancel().
export async function speak(text, lang, {
  onStart, onEnd, onError, onBoundary, gender,
} = {}) {
  if (!speechSupported() || !text) { if (onEnd) onEnd(); return () => {}; }
  const { voice, blocked } = await resolveVoice(lang, gender);
  // A voice for this persona's gender genuinely doesn't exist among the
  // installed voices — stay silent rather than speak the line in the
  // opposite gender's voice (SS-34). The caller's voiceInfo (pickVoiceInfo,
  // status 'none') already surfaces this to the UI; the text itself stays
  // visible, it's just not read aloud.
  if (blocked) { if (onEnd) onEnd(); return () => {}; }
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
