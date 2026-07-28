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
  mira: 'Mira', amara: 'Amara', daniel: 'Daniel', meilin: 'Mei-Lin',
};

export async function getAnswer({ question, lang, module, history = [], avatarId }) {
  const chunks = module.knowledgeChunks || [];
  const local = answerQuestion({ question, lang, chunks, history });

  const base = process.env.LLM_BASE_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  // Keep the off-topic gate deterministic; only enrich on-topic answers.
  if (!base || !key || local.topicality === 'off') return { ...local, provider: 'local' };

  try {
    const context = chunks.map((c) => `## ${c.title}\n${c.text}`).join('\n\n');
    const langName = { en: 'English', de: 'German', it: 'Italian', el: 'Greek' }[lang] || 'English';
    const personaName = PERSONA_NAMES[avatarId] || 'the course presenter';
    const sys = [
      `You are ${personaName}, an intelligent, friendly Scrum trainer, in the middle of teaching the lesson "${module.title || ''}". A learner just interrupted to ask a question. Answer in ${langName}.`,
      'You have ALREADY greeted this learner at the start of the lesson. Never greet again, never say hello, and never introduce yourself or state your name.',
      'Open with one short, natural acknowledgment of the question — e.g. "Thank you for the question." — varied to fit how closely the question relates to the topic you are currently teaching (very relevant: appreciate that it is right on topic; loosely related: note it touches a nearby idea; tangential: gently note it goes a bit beyond today\'s topic). Then go straight into the answer.',
      'Use ONLY the course material below. You may explain, rephrase, give a short example, or compare concepts, but never add facts that are not supported by the material.',
      'If the material does not cover the question, say it is beyond this part of the course. Keep it concise and conversational.',
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
