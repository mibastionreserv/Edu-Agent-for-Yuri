import { answerQuestion } from './qa.js';

// getAnswer chooses the answer engine:
//  - Default: the local grounded composer in qa.js (no key, deterministic).
//  - Optional: an OpenAI-compatible LLM, enabled only when LLM_BASE_URL and
//    LLM_API_KEY are set in the environment (never committed). The LLM is
//    constrained to the module's knowledge and the local engine is always the
//    fallback, so behavior degrades safely if the LLM is unavailable.
// The mid-lesson Q&A voice: the learner and the presenter have already been
// introduced at the start of the lesson, so the answer must NEVER greet or
// self-introduce again — it opens with a brief thank-you/acknowledgment whose
// wording reflects how closely the question relates to what is currently
// being taught, then goes straight into the answer.
const PERSONA_NAMES = {
  mira: 'Mira', yuri: 'Yuri', amara: 'Yuri', daniel: 'Daniel', meilin: 'Mei-Lin',
};

export async function getAnswer({ question, lang, module, history = [], avatarId }) {
  const chunks = module.knowledgeChunks || [];
  const local = answerQuestion({ question, lang, chunks, history });

  const base = process.env.LLM_BASE_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  // When an LLM is configured it handles EVERY turn, including ones the
  // local keyword gate would call "off-topic". The old hard gate trapped
  // conversational turns ("may I interrupt you?", "yes, please continue")
  // in the same canned off-topic reply forever — the learner kept saying
  // "yes please" and kept getting "that's outside our topic". The local
  // engine remains the fallback when no LLM is configured or the call fails.
  if (!base || !key) return { ...local, provider: 'local' };

  try {
    const context = chunks.map((c) => `## ${c.title}\n${c.text}`).join('\n\n');
    const langName = { en: 'English', de: 'German', it: 'Italian', el: 'Greek' }[lang] || 'English';
    const personaName = PERSONA_NAMES[avatarId] || 'the course presenter';
    const sys = [
      `You are ${personaName}, an intelligent, friendly Scrum trainer, in the middle of teaching the lesson "${module.title || ''}". A learner just interrupted to ask a question. Answer in ${langName}.`,
      'You have ALREADY greeted this learner at the start of the lesson. Never greet again, never say hello, and never introduce yourself or state your name.',
      'First decide what kind of turn this is:',
      '(a) A conversational/control phrase rather than a content question — e.g. "may I interrupt you?", "yes", "no", "please continue", "go on", "thank you", "can you repeat that?", "slower please". Respond naturally and VERY briefly like a real teacher mid-conversation ("Of course — what would you like to ask?", "Great — let\'s pick up where we left off.", "You\'re welcome!"). No thank-you opener, no lecture.',
      '(b) A content question about the course: open with one short, natural acknowledgment — e.g. "Thank you for the question." — varied to fit how closely it relates to the topic you are currently teaching (very relevant: appreciate that it is right on topic; loosely related: note it touches a nearby idea; tangential: gently note it goes a bit beyond today\'s topic). Then go straight into the answer.',
      '(c) A content question with no support in the course material: briefly and kindly say it is beyond this part of the course and invite a question on the current topic. Do not repeat this same sentence verbatim across turns — vary the wording, and use the conversation history to react to what was already said.',
      'For content answers use ONLY the course material below. You may explain, rephrase, give a short example, or compare concepts, but never add facts that are not supported by the material. Keep it concise and conversational.',
      '\n--- COURSE MATERIAL ---\n', context,
    ].join(' ');
    const msgs = [
      { role: 'system', content: sys },
      ...history.slice(-4).map((h) => ({ role: h.role === 'learner' ? 'user' : 'assistant', content: h.text })),
      { role: 'user', content: question },
    ];
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: msgs, temperature: 0.3, max_tokens: 300 }),
      // A hung LLM call used to leave the learner's question stuck on
      // "Thinking…" forever — fail fast and fall back to the local
      // grounded composer instead (see the catch block below), SS-6.
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      // Temporary diagnostic: log why the LLM call failed (never logs the key).
      console.error(`[llm] request failed: ${res.status} ${res.statusText} base=${base} model=${model} body=${bodyText.slice(0, 500)}`);
      throw new Error(`LLM ${res.status}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty LLM answer');
    return { topicality: 'on', answer: text, source: local.source, sources: local.sources, intent: local.intent, provider: 'llm' };
  } catch (err) {
    console.error(`[llm] falling back to local: ${err && err.message}`);
    return { ...local, provider: 'local' };
  }
}
