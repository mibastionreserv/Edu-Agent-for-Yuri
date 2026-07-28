// Server-side Tavus conversation minting for the live Tavus avatar (Amara).
//
// Architecture: Amara's PAL already exists on Tavus, pre-created once in
// "echo" pipeline mode (perception/STT/LLM are all bypassed) with a stock
// replica (face) attached. All this module does at runtime is start/stop a
// *conversation* against that persona and hand back the Daily.co room URL.
// The actual "make her talk" step happens client-side: the frontend joins
// that Daily room and broadcasts the narration text as a conversation.echo
// app-message over the call's data channel. Tavus's own TTS engine and
// Phoenix face-rendering engine handle voice synthesis and lip-synced video
// entirely server-side on their end — unlike Mei-Lin/Simli, there's no
// separate TTS call needed here (see tts.js for that other path).
const TAVUS_API = 'https://tavusapi.com/v2';

// Returns { conversationId, conversationUrl }, or throws. Callers should
// catch and keep the learner on the static photo avatar.
export async function createConversation({ conversationName } = {}) {
  const apiKey = process.env.TAVUS_API_KEY;
  const personaId = process.env.TAVUS_PERSONA_ID;
  if (!apiKey || !personaId) throw new Error('Tavus is not configured.');

  const res = await fetch(`${TAVUS_API}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      persona_id: personaId,
      conversation_name: conversationName || 'ScrumStage lesson',
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.conversation_url) {
    const detail = (data && (data.message || data.error)) || `Tavus ${res.status}`;
    throw new Error(detail);
  }
  return { conversationId: data.conversation_id, conversationUrl: data.conversation_url };
}

// Ends a conversation early so free-tier minutes aren't wasted once the
// learner leaves the lesson. Best-effort: never throws.
export async function endConversation(conversationId) {
  const apiKey = process.env.TAVUS_API_KEY;
  if (!apiKey || !conversationId) return;
  try {
    await fetch(`${TAVUS_API}/conversations/${conversationId}/end`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
    });
  } catch {
    // Best-effort cleanup — Tavus will also auto-expire idle conversations.
  }
}
