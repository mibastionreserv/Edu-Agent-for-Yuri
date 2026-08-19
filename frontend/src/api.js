const TOKEN_KEY = 'scrumstage.token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

const REQUEST_TIMEOUT_MS = 20000;
const TTS_TIMEOUT_MS = 30000;

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      // Without this, a hung upstream (TTS/LLM) left the caller (and its
      // "Thinking…"/loading UI) stuck forever — see SS-6.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && e.name === 'TimeoutError') throw new Error('Request timed out. Please try again.');
    throw e;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  register: (b) => request('/auth/register', { method: 'POST', body: b }),
  login: (b) => request('/auth/login', { method: 'POST', body: b }),
  guest: () => request('/auth/guest', { method: 'POST' }),
  course: (lang) => request(`/course?lang=${lang}`),
  uiStrings: (lang) => request(`/ui-strings?lang=${lang}`),
  module: (id, lang) => request(`/modules/${id}?lang=${lang}`),
  getProgress: () => request('/progress', { auth: true }),
  saveProgress: (b) => request('/progress', { method: 'PUT', body: b, auth: true }),
  ask: (b) => request('/ask', { method: 'POST', body: b, auth: true }),
  simliToken: (faceId) => request('/simli-token', { method: 'POST', body: { faceId }, auth: true }),
  simliIce: () => request('/simli-ice', { auth: true }),
  tavusStart: () => request('/tavus-conversation', { method: 'POST', auth: true }),
  tavusEnd: (id) => request(`/tavus-conversation/${id}/end`, { method: 'POST', auth: true }),
};

// Server-generated speech audio (WAV, binary) — bypasses the JSON-only
// request() helper above. Throws on any non-2xx response so callers can fall
// back to the browser's own Web Speech API.
export async function fetchTtsAudio(text, voice) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch('/api/tts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, voice }),
      // A hung TTS call used to leave narration silently stuck forever —
      // fail loudly instead so the caller's fallback path (Web Speech) runs.
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && e.name === 'TimeoutError') throw new Error('tts timed out');
    throw e;
  }
  // Include the status so callers can distinguish a quota rejection (429,
  // surfaced by the backend as a 502 with detail "TTS 429") from a transient
  // flake — retrying the former only burns more quota.
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.clone().json()).detail || ''; } catch { /* not JSON */ }
    throw new Error(`tts failed ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  return res.blob();
}

