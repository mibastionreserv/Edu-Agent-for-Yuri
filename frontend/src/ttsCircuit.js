// Session-wide circuit breaker for server TTS (SS-20).
//
// A 429 (rate limit) is a TEMPORARY condition — retrying immediately only
// burns more of the quota we just ran out of, but the rest of the LESSON
// must not be stuck on the browser fallback voice forever over one busy
// moment. 401/403/"TTS is not configured" are genuinely permanent for the
// session (bad/missing credentials, feature disabled) — no amount of
// waiting fixes those.
//
// State machine: closed -> (failure) -> open -> (cooldown elapsed) ->
// half-open (exactly ONE caller is granted the next attempt) -> closed on
// success, or open again with a longer cooldown on failure. Everything else
// (5xx, "no audio", a timeout, a network blip) is a one-off flake and never
// opens the circuit at all (SS-12).
//
// Module-level singleton on purpose: an upstream TTS outage is a property of
// the session/backend, not of whichever Classroom instance happens to be
// mounted, so it must survive a language/module switch (which remounts
// Classroom) instead of quietly resetting and re-spending quota.

const BACKOFF_MS = [45_000, 90_000, 180_000, 300_000, 600_000];

// A granted half-open probe that never resolves (e.g. the caller bailed out
// before even calling fetch, such as the narration <audio> element not being
// mounted yet) must not wedge the circuit open forever.
const PROBE_TIMEOUT_MS = 35_000;

let status = 'closed'; // 'closed' | 'open' | 'half-open'
let openUntil = 0;
let probeGrantedAt = 0;
let consecutiveFailures = 0;
let permanentlyOpen = false;

function now() { return Date.now(); }

function backoffFor(n) {
  return BACKOFF_MS[Math.min(Math.max(n, 1) - 1, BACKOFF_MS.length - 1)];
}

// Classifies off the structured `detail` field the backend puts on a TTS
// failure (see backend/src/tts.js / app.js: "TTS 429", "TTS 401", "TTS 403",
// "TTS is not configured.") — never off the whole error message, which can
// also contain digits from an unrelated HTTP status (our own expired-session
// 401 has no such `detail` at all).
function classify(err) {
  const detail = String((err && err.detail) || '');
  if (/not configured/i.test(detail)) return 'permanent';
  if (/\b(401|403)\b/.test(detail)) return 'permanent';
  if (/\b429\b/.test(detail)) return 'rate-limit';
  return 'transient';
}

// Whether a caller may attempt server TTS right now. Mutates: when the
// cooldown has just elapsed this GRANTS the single half-open probe and
// returns true exactly once, so callers must actually attempt TTS (and
// report back via recordSuccess/recordFailure) whenever this returns true —
// don't call it speculatively.
export function canAttempt() {
  if (permanentlyOpen) return false;
  if (status === 'half-open') {
    if (now() - probeGrantedAt <= PROBE_TIMEOUT_MS) return false;
    // The previous probe never reported back — don't wedge the circuit
    // open forever, fall back to a normal cooldown instead.
    status = 'open';
    openUntil = now() + backoffFor(consecutiveFailures || 1);
  }
  if (status === 'closed') return true;
  if (now() < openUntil) return false;
  status = 'half-open';
  probeGrantedAt = now();
  return true;
}

export function recordSuccess() {
  status = 'closed';
  openUntil = 0;
  consecutiveFailures = 0;
  permanentlyOpen = false;
}

// Returns the classification ('permanent' | 'rate-limit' | 'transient') so
// callers can also decide whether an inline retry is worth it (never for the
// first two — see backend/src/tts.js's own note on 429 retries).
export function recordFailure(err) {
  const kind = classify(err);
  if (kind === 'permanent') {
    permanentlyOpen = true;
    status = 'open';
    openUntil = Infinity;
    return kind;
  }
  if (kind === 'rate-limit') {
    consecutiveFailures += 1;
    status = 'open';
    openUntil = now() + backoffFor(consecutiveFailures);
    return kind;
  }
  // Transient: never latches the whole session onto the fallback voice. If
  // this was the half-open probe, drop back to closed so the very next line
  // still tries the server instead of waiting out a cooldown for no reason.
  if (status === 'half-open') { status = 'closed'; openUntil = 0; }
  return kind;
}

// Read-only snapshot for UI/diagnostics — never mutates, safe to call from a
// render path (unlike canAttempt()).
export function state() {
  return {
    status: permanentlyOpen ? 'open' : status,
    openUntil,
    consecutiveFailures,
    permanent: permanentlyOpen,
  };
}

// Test-only: vitest specs share this module across `it()` blocks.
export function _resetForTests() {
  status = 'closed';
  openUntil = 0;
  probeGrantedAt = 0;
  consecutiveFailures = 0;
  permanentlyOpen = false;
}
