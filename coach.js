// Coaching layer: live suggestions, full reply, and the closing report.
// Two interchangeable providers: Groq (OpenAI-compatible) and Claude (Anthropic).

export const PROVIDERS = {
  groq: {
    label: 'Groq',
    cost: 'gratis, sin tarjeta',
    keyField: 'groqKey',
    models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'groq/compound-mini'],
    // Free-plan window, shared across every call. It is the only provider fact
    // the memory layer needs: chunk size and cadence derive from it.
    tpm: 8000,
  },
  anthropic: {
    label: 'Claude',
    cost: 'de pago por uso',
    keyField: 'anthropicKey',
    models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'],
    tpm: null,
  },
};

export const DEFAULT_COACH = {
  liveCoach: true,
  liveProvider: 'groq',
  liveModel: 'openai/gpt-oss-20b',
  reportProvider: 'groq',
  reportModel: 'openai/gpt-oss-120b',
  autoReport: true,
  level: 'B1-B2',
  situation: 'conversación de trabajo en inglés',
  profile: '',
  sessionContext: '',
  lang: 'en',
};

// Profile cap. Enough for a summarised real background without eating Groq's free
// minute, and it stops a whole six-page CV pasted in from blowing through it.
export const PROFILE_MAX_CHARS = 1500;

// Deliberately NOT used in askHints: the chips run every six seconds, and repeating
// the profile in every round exhausts the tokens-per-minute limit.
function profileBlock(settings) {
  const texto = (settings.profile || '').trim().slice(0, PROFILE_MAX_CHARS);
  if (!texto) return '';
  return `\n\nAbout the learner (their real background — use ONLY these facts, never invent experience):\n${texto}`;
}

// Per-meeting notes ("entrevista técnica de Angular: signals, RxJS…"). Same
// token-budget rule as the profile: reply and report only, never the chips.
export const CONTEXT_MAX_CHARS = 1500;

export function contextBlock(settings) {
  const texto = (settings.sessionContext || '').trim().slice(0, CONTEXT_MAX_CHARS);
  if (!texto) return '';
  return `\n\nToday's conversation context (topics and notes the learner wrote for this meeting — lean on them when answering knowledge questions):\n${texto}`;
}

class CoachError extends Error {}

// API errors end up in the interface, in a system notification, and stored in
// chrome.storage. If a provider echoes the credential in the error body, it would
// leak through all three.
const KEY_SHAPED = /(gsk_[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,}|xai-[A-Za-z0-9_-]{6,})/g;
export const redact = (text) => String(text ?? '').replace(KEY_SHAPED, '«API key oculta»');

// Endpoints are configurable: enough to point at an OpenAI-compatible server
// (Ollama, LM Studio, your own proxy) without touching the code.
const GROQ_DEFAULT = 'https://api.groq.com';
const ANTHROPIC_DEFAULT = 'https://api.anthropic.com';
export const groqBaseOf = (s = {}) => (s.groqBase || GROQ_DEFAULT).replace(/\/$/, '');
export const anthropicBaseOf = (s = {}) => (s.anthropicBase || ANTHROPIC_DEFAULT).replace(/\/$/, '');

// Only the gpt-oss models accept json_schema with constrained decoding, the one
// mode that cannot return invalid JSON. json_object validates after generation, and
// these models leak reasoning tokens into the output: Groq rejects it with
// json_validate_failed and the whole round of chips is lost.
const SUPPORTS_JSON_SCHEMA = /^openai\/gpt-oss/;

function groqResponseFormat(model, schema) {
  if (!schema) return {};
  if (SUPPORTS_JSON_SCHEMA.test(model)) {
    return { response_format: { type: 'json_schema', json_schema: { name: 'coach', schema, strict: true } } };
  }
  return { response_format: { type: 'json_object' } };
}

async function callGroq({ key, model, system, user, maxTokens, schema, base }) {
  const res = await fetch(`${base}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      temperature: 0.3,
      ...groqResponseFormat(model, schema),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (res.status === 429) {
    throw new CoachError('Groq: límite del plan gratuito alcanzado (8000 tokens por minuto). Espera un minuto y vuelve a intentarlo.');
  }
  if (!res.ok) {
    const cuerpo = redact(await res.text());
    if (/json_validate_failed/.test(cuerpo)) {
      throw new CoachError('Groq cortó la respuesta a medias (JSON inválido). Vuelve a intentarlo una vez.');
    }
    throw new CoachError(`Groq ${res.status}: ${cuerpo.slice(0, 180)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic({ key, model, system, user, maxTokens, base }) {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const cuerpo = redact(await res.text());
    if (/credit balance|billing/i.test(cuerpo)) {
      throw new CoachError('Claude: la cuenta no tiene saldo. Cambia el modelo del informe a Groq en Ajustes, que es gratuito.');
    }
    throw new CoachError(`Claude ${res.status}: ${cuerpo.slice(0, 180)}`);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// With only one key configured, the chosen provider may not be the one that has it.
// Failing outright leaves the user with no report despite having the means to make one.
export function resolveProvider(preferred, keys = {}) {
  const orden = [preferred, ...Object.keys(PROVIDERS).filter((p) => p !== preferred)];
  for (const p of orden) {
    const spec = PROVIDERS[p];
    if (spec && keys[spec.keyField]) {
      return { provider: p, label: spec.label, fallback: p !== preferred };
    }
  }
  return null;
}

async function ask({ provider, model, keys, system, user, maxTokens = 700, schema = null }) {
  if (!PROVIDERS[provider]) throw new CoachError('Proveedor desconocido: ' + provider);
  const elegido = resolveProvider(provider, keys);
  if (!elegido) {
    throw new CoachError(`Falta la API key de ${PROVIDERS[provider].label} (ábrela en Ajustes).`);
  }
  // The requested model belongs to the original provider: switching means changing it.
  const usado = elegido.fallback ? PROVIDERS[elegido.provider].models[0] : model;
  const key = keys[PROVIDERS[elegido.provider].keyField];
  if (elegido.provider === 'groq') {
    return callGroq({ key, model: usado, system, user, maxTokens, schema, base: groqBaseOf(keys) });
  }
  return callAnthropic({ key, model: usado, system, user, maxTokens, base: anthropicBaseOf(keys) });
}

// Extracts the first JSON object from a response, tolerating prose or ```json fences.
export function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

// Groq's free tier allows 8000 tokens per minute across input and output. A report
// carrying the whole transcript eats that and returns 429, so the oldest turns are
// trimmed until it fits. Four characters per token is the usual rule of thumb.
export function turnsToText(turns, limit = 10, maxChars = Infinity) {
  const lines = turns
    .slice(-limit)
    .map((t) => `${t.speaker === 'me' ? 'LEARNER' : 'OTHER'}: ${t.text}`);
  if (maxChars === Infinity) return lines.join('\n');

  const kept = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > maxChars && kept.length) break;
    kept.unshift(lines[i]);
  }
  return kept.join('\n');
}

// Distilled topics now cover the region this used to cut silently, so the tail
// can shrink to pay for them: coverage goes up while the token cost stays flat.
const REPORT_MAX_CHARS = 8000;

export const coverageOf = (m = {}) => {
  const total = (m.rounds || 0) + (m.skipped || 0);
  return total ? Math.round(((m.rounds || 0) / total) * 100) : 100;
};

// The distilled record of the whole conversation, so the summary stops being
// built from whatever fitted in the tail.
export function memoryBlock(memory, recurring = []) {
  // `recurring` is an independent input: a session with no distilled memory at all
  // still has a history worth showing.
  if (!memory && !recurring.length) return '';
  const { topics = [], open = [], errors = [] } = memory || {};
  if (!topics.length && !open.length && !errors.length && !recurring.length) return '';
  const parts = [];
  if (topics.length) parts.push('TEMAS REGISTRADOS (cubren toda la conversación):\n'
    + topics.map((t) => `  · ${t.text}`).join('\n'));
  if (open.length) parts.push('PENDIENTES REGISTRADOS:\n' + open.map((t) => `  · ${t.text}`).join('\n'));
  if (errors.length) parts.push('ERRORES DETECTADOS (ya verificados contra la transcripción):\n'
    + errors.map((e) => `  · ${e.wrong} → ${e.right} [${e.kind}] — dijo: "${e.said}"`).join('\n'));
  if (recurring.length) parts.push('ERRORES RECURRENTES (detectados en varias conversaciones anteriores):\n'
    + recurring.map((e) => `  · ${e.wrong} → ${e.right} — ${e.count} conversaciones`).join('\n'));
  const cobertura = coverageOf(memory);
  if (cobertura < 100) parts.push(`COBERTURA: la memoria cubre aproximadamente el ${cobertura}% de la conversación.`);
  return parts.join('\n\n');
}

// Spanish-session override, appended to the live prompts: same structure and
// fields, but the phrases to say are Spanish and a gloss is pointless for a
// native speaker — there the coach is professional support, not language help.
const SPANISH_MODE = `

IMPORTANT OVERRIDE: this conversation is in SPANISH, the learner's NATIVE language. They need
professional support (what to say, how to phrase it well in a work setting), not language help.
Every "en" field must contain the SPANISH phrase to say, in professional spoken register.
Return "es" as an empty string. "nudge" stays in Spanish.`;

const langMode = (settings) => (settings.lang === 'es' ? SPANISH_MODE : '');

// --- 1. Vocabulary chips after each of the other speaker's turns --------------

const HINT_SYSTEM = `You help a Spanish-speaking professional keep up in a live English conversation.
Given the recent turns, return:
"words": 3 or 4 short items the learner is likely to need RIGHT NOW to answer — useful
collocations, phrasal verbs or connectors, not full sentences, 1 to 4 words each.
"openers": 2 or 3 short natural ways to BEGIN answering what was just said — connectors or
framing phrases, 2 to 6 words each, spoken register.
"nudge": one very short hint (max 8 words, in Spanish) about how to steer the answer.
Each words/openers item has "en" and "es" (Spanish gloss, max 5 words).
Reply ONLY with JSON: {"words":[{"en":"...","es":"..."}],"openers":[{"en":"...","es":"..."}],"nudge":"..."}`;

const HINT_SCHEMA = {
  type: 'object',
  properties: {
    words: {
      type: 'array',
      items: {
        type: 'object',
        properties: { en: { type: 'string' }, es: { type: 'string' } },
        required: ['en', 'es'],
        additionalProperties: false,
      },
    },
    openers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { en: { type: 'string' }, es: { type: 'string' } },
        required: ['en', 'es'],
        additionalProperties: false,
      },
    },
    nudge: { type: 'string' },
  },
  required: ['words', 'openers', 'nudge'],
  additionalProperties: false,
};

// Shared by the live hints and the pre-conversation starter: both broadcast the
// same HINTS shape. Pure so Node can test it.
export function parseHints(raw) {
  const parsed = parseJsonLoose(raw);
  if (!parsed || !Array.isArray(parsed.words)) throw new CoachError('Respuesta de sugerencias no válida.');
  return {
    words: parsed.words.filter((w) => w && w.en).slice(0, 4),
    openers: cleanItems(parsed.openers).slice(0, 3),
    nudge: typeof parsed.nudge === 'string' ? parsed.nudge : '',
  };
}

export async function askHints({ turns, settings }) {
  const raw = await ask({
    provider: settings.liveProvider,
    model: settings.liveModel,
    keys: settings,
    system: HINT_SYSTEM + langMode(settings),
    user: `Learner level: ${settings.level}. Context: ${settings.situation}.\n\nConversation so far:\n${turnsToText(turns, 8)}`,
    maxTokens: 700,
    schema: HINT_SCHEMA,
  });
  return parseHints(raw);
}

// --- 1b. Starter kit before the first turn ------------------------------------

const STARTER_SYSTEM = `You help a Spanish-speaking professional get ready for an English
conversation that is about to start. From the situation and their notes, return:
"words": 4 short items they will likely need in THIS topic — connectors, collocations or
phrasal verbs that make them sound natural, 1 to 4 words each.
"openers": 2 or 3 short natural ways to begin an answer in this situation, 2 to 6 words each,
spoken register.
"nudge": one very short tip (max 8 words, in Spanish) to sound natural here.
Each words/openers item has "en" and "es" (Spanish gloss, max 5 words).
Reply ONLY with JSON: {"words":[{"en":"...","es":"..."}],"openers":[{"en":"...","es":"..."}],"nudge":"..."}`;

// One call per session (and per mid-session context edit), on the cheap live
// model: it primes the chips before the other person has said anything.
export async function askStarter({ settings }) {
  const raw = await ask({
    provider: settings.liveProvider,
    model: settings.liveModel,
    keys: settings,
    system: STARTER_SYSTEM + langMode(settings),
    user: `Learner level: ${settings.level}. Situation: ${settings.situation}.${contextBlock(settings)}`,
    maxTokens: 700,
    schema: HINT_SCHEMA,
  });
  return parseHints(raw);
}

// --- 1c. Rolling distillation of the conversation ----------------------------

// The live provider runs the hints and the distiller; the report provider runs the
// reply and the report. They can differ, and the ledger pools them, so the policy
// takes the tightest window in play: with one metered half, a 429 is still on the
// table. An unknown provider is assumed metered — over-restricting costs a skipped
// round, under-restricting costs a 429 in the middle of a meeting.
export function tpmOf(settings = {}) {
  const budgets = [settings.liveProvider, settings.reportProvider]
    .map((p) => (PROVIDERS[p] ? PROVIDERS[p].tpm : 8000))
    .filter((t) => t !== null);
  return budgets.length ? Math.min(...budgets) : null;
}

const DISTILL_SYSTEM = `You maintain a running memory of a live conversation for a language coach.
"LEARNER" is the person being coached; "OTHER" is the person they are talking to.

Read ONLY the NEW FRAGMENT. The CONTEXT section is already processed: use it for continuity,
never extract from it.

Return:
"topics": up to 3 things actually discussed that will matter later. Each has "text" (one short
sentence, in the language of the transcript) and "quote" (at least 12 characters copied EXACTLY
from the new fragment).
"open": commitments or unresolved items — something to review, send, decide or schedule. Same
shape as topics. Empty array if there are none.
"errors": mistakes in the LEARNER's own lines. Each has "wrong" (the exact wrong words, copied
EXACTLY from a LEARNER line, at most 8 words), "right" (the corrected form) and "kind", one of
"grammar", "calque" (a literal translation from Spanish) or "register".
"carry": one line naming the thread still open where the fragment ends, or "" if it closed cleanly.

The transcript comes from automatic speech recognition. A phrase with nonexistent words or
mangled technical jargon ("request quid", "ray-tree after heater") is almost always the recogniser
destroying a term, not a learner mistake: treat it as noise and never report it.

When in doubt, leave it out. A missing item costs nothing; an invented one poisons a record that
is kept. Reply ONLY with JSON.`;

const QUOTED_ITEMS = {
  type: 'array',
  items: {
    type: 'object',
    properties: { text: { type: 'string' }, quote: { type: 'string' } },
    required: ['text', 'quote'],
    additionalProperties: false,
  },
};

const DISTILL_SCHEMA = {
  type: 'object',
  properties: {
    topics: QUOTED_ITEMS,
    open: QUOTED_ITEMS,
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          wrong: { type: 'string' },
          right: { type: 'string' },
          kind: { type: 'string', enum: ['grammar', 'calque', 'register'] },
        },
        required: ['wrong', 'right', 'kind'],
        additionalProperties: false,
      },
    },
    carry: { type: 'string' },
  },
  required: ['topics', 'open', 'errors', 'carry'],
  additionalProperties: false,
};

// Shape only. Whether any of this is true is decided in memory.js, against the
// transcript, without asking the model anything.
export function parseDistill(raw) {
  const parsed = parseJsonLoose(raw);
  if (!parsed) throw new CoachError('Respuesta de destilación no válida.');
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    topics: list(parsed.topics),
    open: list(parsed.open),
    errors: list(parsed.errors),
    carry: typeof parsed.carry === 'string' ? parsed.carry.trim() : '',
  };
}

// Runs on the live (cheap) model: this is background work that must never
// compete with the reply the learner is waiting for.
export async function askDistill({ chunk, settings }) {
  const raw = await ask({
    provider: settings.liveProvider,
    model: settings.liveModel,
    keys: settings,
    system: DISTILL_SYSTEM,
    user: `Situation: ${settings.situation}.`
      + (chunk.carry ? `\n\nThe previous fragment ended while discussing: ${chunk.carry}` : '')
      + (chunk.overlap ? `\n\nCONTEXT (already processed, do not extract):\n${chunk.overlap}` : '')
      + `\n\nNEW FRAGMENT:\n${chunk.text}`,
    // Reasoning models spend from the same budget before writing the JSON.
    maxTokens: 900,
    schema: DISTILL_SCHEMA,
  });
  return parseDistill(raw);
}

// --- 2. Full reply on demand (keyboard shortcut) -----------------------------

const REPLY_SYSTEM = `You are helping a Spanish-speaking professional answer in a live English
conversation. They will read your answer OUT LOUD while the other person waits, so it must be
SPEAKABLE, not impressive.

"answer": EXACTLY ONE answer to the LAST question or point the other person raised — your single
best option, never alternatives. Spoken register, at the learner's level. Sentences of 12 words
or fewer; two short sentences beat one complex one. Everyday words the learner already knows; at
most ONE technical term per sentence, and only when the topic truly needs it — wrap that term in
**double asterisks** so the interface can highlight it. For a knowledge question (e.g. a
technical interview) the answer must be CORRECT: use the conversation-context notes if provided
plus your own knowledge, said simply. If the last turn was not a question, give the most natural
next thing to say.

"ideas": exactly 2 richer ways to express the same answer — fuller sentences with the precise
terminology, for the learner to STUDY after the conversation, not to read live.

Every item needs "en" (exactly what to say) and "es" (a short Spanish gloss, max 6 words).

If a background section is provided, ground personal answers in those real facts. Technical and
conceptual knowledge is fair game: teach them the right answer. What you must never invent is
their biography — employers, job titles, numbers or achievements not stated in the background:
the learner has to say this out loud as the truth. If the background does not cover a personal
question, stay honest and general rather than fabricating detail.

Facts about THIS conversation may come only from the LITERAL RECORD and RECENT blocks. The
SITUATION block orients you and is not quotable as fact. Never say or imply that something was
discussed unless it appears in one of those two blocks.`;

const REPLY_ITEMS = {
  type: 'array',
  items: {
    type: 'object',
    properties: { en: { type: 'string' }, es: { type: 'string' } },
    required: ['en', 'es'],
    additionalProperties: false,
  },
};

const REPLY_SCHEMA = {
  type: 'object',
  properties: { answer: REPLY_ITEMS, ideas: REPLY_ITEMS },
  required: ['answer', 'ideas'],
  additionalProperties: false,
};

const cleanItems = (list) => (Array.isArray(list) ? list : [])
  .filter((i) => i && typeof i.en === 'string' && i.en.trim())
  .map((i) => ({ en: i.en.trim().replace(/^["“]|["”]$/g, ''), es: (i.es || '').trim() }))
  .slice(0, 4);

// Pure so Node can test it: the model's raw text in, the two groups out. One
// answer only — in a live conversation the learner reads the first option
// anyway, so alternatives are cost (screen, tokens, hesitation), not help.
export function parseReply(raw) {
  const parsed = parseJsonLoose(raw);
  if (!parsed) throw new CoachError('Respuesta no válida del modelo.');
  const answer = cleanItems(parsed.answer).slice(0, 1);
  const ideas = cleanItems(parsed.ideas).slice(0, 2);
  if (!answer.length && !ideas.length) {
    throw new CoachError('El modelo no devolvió ninguna opción.');
  }
  return { answer, ideas };
}

// Three sources with three different truth rules. The reply already separated two
// of them — biography is not invented, technical knowledge is fair game — and this
// adds the third: what the conversation actually contains.
export function contextBlocks(context) {
  if (!context) return '';
  const parts = [];
  if (context.situation?.length) {
    parts.push('SITUATION (background — orients you, NOT quotable as fact)\n'
      + context.situation.map((s) => `  · ${s.text}`).join('\n'));
  }
  if (context.evidence?.length) {
    parts.push('LITERAL RECORD (exact words spoken earlier — you may rely on these)\n'
      + context.evidence.map((t) => `  · ${t.speaker === 'me' ? 'LEARNER' : 'OTHER'}: "${t.text}"`).join('\n'));
  } else if (context.mode === 'new') {
    // An absent block invites the model to fill the gap; a declared absence does not.
    parts.push('NOTHING earlier in this conversation covers this question. Do not imply it was discussed.');
  }
  if (context.tail) parts.push(`RECENT (the immediate thread)\n${context.tail}`);
  return parts.join('\n\n');
}

export async function askReply({ turns, settings, context = null }) {
  const conversation = context
    ? contextBlocks(context)
    // No prepared context (no memory yet, or a caller that predates it): the old
    // character-capped tail, which is still correct, just short-sighted.
    : `RECENT (the immediate thread)\n${turnsToText(turns, 10, 1200)}`;
  // The report's (bigger) model, not the live one: the reply is on demand, so the
  // extra latency is paid once, and knowledge questions need the stronger model.
  const raw = await ask({
    provider: settings.reportProvider,
    model: settings.reportModel,
    keys: settings,
    system: REPLY_SYSTEM + langMode(settings),
    user: `Learner level: ${settings.level}. Context: ${settings.situation}.`
      + `${profileBlock(settings)}${contextBlock(settings)}`
      + `\n\n${conversation}`
      + `\n\nAnswer the other person's last turn for the learner: one speakable answer, then two study ideas.`,
    // The JSON itself is ~200 tokens, but gpt-oss models spend reasoning tokens
    // from the same budget BEFORE writing it: a tight cap truncates the JSON and
    // Groq rejects the call with 400 json_validate_failed.
    maxTokens: 1200,
    schema: REPLY_SCHEMA,
  });
  return parseReply(raw);
}

// --- 3. Closing report -------------------------------------------------------

const REPORT_SYSTEM = `Eres un profesor de inglés que analiza una conversación real de un hispanohablante.
"LEARNER" es tu alumno; "OTHER" es la otra persona. El «Resumen de la reunión» usa TODA la
conversación; el resto de secciones analiza SOLO las intervenciones del alumno.
La transcripción viene de reconocimiento automático: ignora errores obvios de puntuación o de
transcripción fonética y no los reportes como errores del alumno. Una frase con palabras
inexistentes o jerga técnica deformada («request quid», «ray-tree after heater») es casi siempre
el reconocedor destrozando un término técnico, no un error del alumno: trátala como ruido y no
la lleves a la tabla de gramática.

El «Resumen de la reunión» se construye A PARTIR DE LOS TEMAS REGISTRADOS que se te entregan: no
añadas ningún tema que no esté en esa lista. Los «Pendientes» salen únicamente de los PENDIENTES
REGISTRADOS. La tabla de errores parte de los ERRORES DETECTADOS: explícalos y ordénalos por
importancia; puedes añadir como máximo dos más que encuentres en la transcripción.
Si se te indica una COBERTURA por debajo del 100%, dilo en una línea al final del resumen.

Responde en español, en Markdown, con exactamente estas secciones:

## Resumen de la reunión
De qué se habló, en 3 o 4 viñetas concretas con lo importante. Termina con una línea
**Pendientes:** y los compromisos o temas que quedaron abiertos (algo que revisar, enviar,
decidir o agendar), tomados solo de la transcripción. Si no quedó nada pendiente, dilo en una línea.

## Cómo lo hiciste
Dos o tres frases sobre cómo se desempeñó, concretas, sin adular.

## Errores de gramática
Tabla con columnas | Dijiste | Correcto | Por qué |. Máximo 8 filas, las más importantes.

## Traducciones literales del español
Lista de calcos detectados y cómo lo diría un nativo. Si no hay, dilo en una línea.

## Conectores y frases para aprender
Los conectores que le faltaron para hilar sus respuestas y 4 o 5 frases hechas que le conviene
memorizar para esta situación. Cada una con el inglés en negrita, una glosa corta en español y
el momento real de la conversación donde encajaba.

## Vocabulario para subir de nivel
5 expresiones que encajaban en esta conversación y no usó, cada una con un ejemplo tomado del contexto real.

## Fluidez
Muletillas, repeticiones, frases inacabadas. Menciónalo solo si hay evidencia en la transcripción.

## Lo que tienes que aprender
Las 5 frases o palabras que más te conviene memorizar a partir de tus propios errores de hoy.
Cada una con el inglés en negrita, una glosa corta en español y la frase real donde falló.
Si se te entregan ERRORES RECURRENTES, empieza por ellos y dilo explícitamente: son los que el
alumno repite en varias conversaciones, no fallos de hoy.

## Nivel y plan
Nivel CEFR aproximado con una frase de justificación, tres ejercicios concretos para esta semana
y un consejo profesional de coach: qué hacer distinto en la próxima conversación para que cada
una mejore la anterior.`;

// In a Spanish session the learner is a native speaker: grading their Spanish
// grammar or CEFR level would be noise. The report becomes a communication
// coach — clarity, fillers, better phrasings, professional formulas.
const REPORT_SYSTEM_ES = `Eres un coach de comunicación profesional que analiza una conversación
real EN ESPAÑOL de un profesional hispanohablante (por ejemplo, una entrevista técnica).
"LEARNER" es tu cliente; "OTHER" es la otra persona. El «Resumen de la reunión» usa TODA la
conversación; el resto de secciones analiza SOLO las intervenciones del cliente.
La transcripción viene de reconocimiento automático: palabras inexistentes o jerga deformada
son ruido del reconocedor, no errores del cliente — ignóralas.

El «Resumen de la reunión» se construye A PARTIR DE LOS TEMAS REGISTRADOS que se te entregan: no
añadas ningún tema que no esté en esa lista. Los «Pendientes» salen únicamente de los PENDIENTES
REGISTRADOS. La tabla de errores parte de los ERRORES DETECTADOS: explícalos y ordénalos por
importancia; puedes añadir como máximo dos más que encuentres en la transcripción.
Si se te indica una COBERTURA por debajo del 100%, dilo en una línea al final del resumen.

Responde en español, en Markdown, con exactamente estas secciones:

## Resumen de la reunión
De qué se habló, en 3 o 4 viñetas concretas con lo importante. Termina con una línea
**Pendientes:** y los compromisos o temas que quedaron abiertos (algo que revisar, enviar,
decidir o agendar), tomados solo de la transcripción. Si no quedó nada pendiente, dilo en una línea.

## Cómo lo hiciste
Dos o tres frases sobre claridad, estructura y seguridad al responder, concretas, sin adular.

## Respuestas que se podían decir mejor
Tabla con columnas | Dijiste | Mejor | Por qué |. Máximo 6 filas: claridad, precisión técnica o
registro profesional — no corrijas gramática de nativo.

## Muletillas y fluidez
Muletillas, repeticiones, rodeos y frases inacabadas. Menciónalo solo si hay evidencia en la
transcripción.

## Fórmulas profesionales para aprender
4 o 5 fórmulas que encajaban en esta conversación (para estructurar una respuesta, ganar unos
segundos, cerrar un punto), cada una con el momento real donde encajaba. Empieza por las que
corrigen los ERRORES DETECTADOS que se te entregan, si los hay.
Si se te entregan ERRORES RECURRENTES, empieza por ellos y dilo explícitamente: son los que el
alumno repite en varias conversaciones, no fallos de hoy.

## Plan
Tres ejercicios concretos para esta semana y un consejo profesional de coach: qué hacer distinto
en la próxima conversación para que cada una mejore la anterior.`;

export async function askReport({ turns, settings, memory = null, recurring = [] }) {
  const mine = turns.filter((t) => t.speaker === 'me').length;
  if (mine === 0) throw new CoachError('No hay intervenciones tuyas para analizar.');
  const texto = turnsToText(turns, 400, REPORT_MAX_CHARS);
  const recortada = texto.split('\n').length < turns.length;
  const recuerdo = memoryBlock(memory, recurring);
  return ask({
    provider: settings.reportProvider,
    model: settings.reportModel,
    keys: settings,
    system: settings.lang === 'es' ? REPORT_SYSTEM_ES : REPORT_SYSTEM,
    user: `Nivel declarado: ${settings.level}. Contexto: ${settings.situation}.`
      + `${profileBlock(settings)}${contextBlock(settings)}\n\n`
      + (recuerdo ? `${recuerdo}\n\n` : '')
      + `Transcripción${recortada ? ' (sólo la parte final de la conversación)' : ' completa'}:\n${texto}`,
    maxTokens: 2800,
  });
}
