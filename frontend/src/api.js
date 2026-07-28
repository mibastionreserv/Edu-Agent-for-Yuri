const TOKEN_KEY = 'scrumstage.token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
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
};

// Server-generated speech audio (WAV, binary) — bypasses the JSON-only
// request() helper above. Throws on any non-2xx response so callers can fall
// back to the browser's own Web Speech API.
export async function fetchTtsAudio(text, voice) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) throw new Error('tts failed');
  return res.blob();
}

