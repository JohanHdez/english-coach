// Coaching layer: live suggestions, full reply, and the closing report.
// Two interchangeable providers: Groq (OpenAI-compatible) and Claude (Anthropic).

export const PROVIDERS = {
  groq: {
    label: 'Groq',
    cost: 'gratis, sin tarjeta',
    keyField: 'groqKey',
    models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'groq/compound-mini'],
  },
  anthropic: {
    label: 'Claude',
    cost: 'de pago por uso',
    keyField: 'anthropicKey',
    models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'],
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
  if (!res.ok) throw new CoachError(`Groq ${res.status}: ${redact(await res.text()).slice(0, 180)}`);
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
function turnsToText(turns, limit = 10, maxChars = Infinity) {
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

// Leaves room for the system prompt and the 2500 output tokens within the free minute.
const REPORT_MAX_CHARS = 12000;

// --- 1. Vocabulary chips after each of the other speaker's turns --------------

const HINT_SYSTEM = `You help a Spanish-speaking professional keep up in a live English conversation.
Given the recent turns, return 3 or 4 short items the learner is likely to need RIGHT NOW to answer:
useful collocations, phrasal verbs or connectors — not full sentences, 1 to 4 words each.
Also add one very short nudge (max 8 words, in Spanish) about how to steer the answer.
Reply ONLY with JSON: {"words":[{"en":"...","es":"..."}],"nudge":"..."}`;

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
    nudge: { type: 'string' },
  },
  required: ['words', 'nudge'],
  additionalProperties: false,
};

export async function askHints({ turns, settings }) {
  const raw = await ask({
    provider: settings.liveProvider,
    model: settings.liveModel,
    keys: settings,
    system: HINT_SYSTEM,
    user: `Learner level: ${settings.level}. Context: ${settings.situation}.\n\nConversation so far:\n${turnsToText(turns, 8)}`,
    maxTokens: 700,
    schema: HINT_SCHEMA,
  });
  const parsed = parseJsonLoose(raw);
  if (!parsed || !Array.isArray(parsed.words)) throw new CoachError('Respuesta de sugerencias no válida.');
  return {
    words: parsed.words.filter((w) => w && w.en).slice(0, 4),
    nudge: typeof parsed.nudge === 'string' ? parsed.nudge : '',
  };
}

// --- 2. Full reply on demand (keyboard shortcut) -----------------------------

const REPLY_SYSTEM = `You are helping a Spanish-speaking professional answer in a live English
conversation. Give them BUILDING BLOCKS, not one canned answer: they are mid-conversation and
need to pick something fast and say it out loud.

"openers": 3 or 4 short ways to BEGIN answering what was just asked — connectors, framing
phrases, or natural ways to buy a second while they think. 2 to 8 words each, spoken register.

"ideas": 3 or 4 different ways to say the SUBSTANCE of their answer. One sentence each, spoken
register, at the learner's level. This is the part they get stuck on: they know what they mean
in Spanish and cannot phrase it in English. Prefer concrete, specific wording — name the result,
the metric, the mechanism — over vague phrasing. Offer genuinely different angles, not three
rewordings of the same sentence.

Every item needs "en" (exactly what to say) and "es" (a short Spanish gloss, max 6 words, so they
can pick at a glance without reading the English first).

If a background section is provided, ground the ideas in those real facts — concrete projects,
tools and results beat generic phrasing in an interview. Never invent employers, job titles,
numbers or achievements that are not stated there: the learner has to say this out loud as the
truth. If the background does not cover what was asked, stay honest and general rather than
fabricating detail.`;

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
  properties: { openers: REPLY_ITEMS, ideas: REPLY_ITEMS },
  required: ['openers', 'ideas'],
  additionalProperties: false,
};

const cleanItems = (list) => (Array.isArray(list) ? list : [])
  .filter((i) => i && typeof i.en === 'string' && i.en.trim())
  .map((i) => ({ en: i.en.trim().replace(/^["“]|["”]$/g, ''), es: (i.es || '').trim() }))
  .slice(0, 4);

export async function askReply({ turns, settings }) {
  const raw = await ask({
    provider: settings.liveProvider,
    model: settings.liveModel,
    keys: settings,
    system: REPLY_SYSTEM,
    user: `Learner level: ${settings.level}. Context: ${settings.situation}.${profileBlock(settings)}`
      + `\n\nConversation so far:\n${turnsToText(turns, 10)}`
      + `\n\nGive the learner openers and ideas for what to say next.`,
    maxTokens: 900,
    schema: REPLY_SCHEMA,
  });
  const parsed = parseJsonLoose(raw);
  if (!parsed) throw new CoachError('Respuesta no válida del modelo.');
  const openers = cleanItems(parsed.openers);
  const ideas = cleanItems(parsed.ideas);
  if (!openers.length && !ideas.length) throw new CoachError('El modelo no devolvió ninguna opción.');
  return { openers, ideas };
}

// --- 3. Closing report -------------------------------------------------------

const REPORT_SYSTEM = `Eres un profesor de inglés que analiza una conversación real de un hispanohablante.
"LEARNER" es tu alumno; "OTHER" es la otra persona. Analiza SOLO las intervenciones del alumno.
La transcripción viene de reconocimiento automático: ignora errores obvios de puntuación o de
transcripción fonética y no los reportes como errores del alumno.

Responde en español, en Markdown, con exactamente estas secciones:

## Resumen
Dos o tres frases sobre cómo se desempeñó, concretas, sin adular.

## Errores de gramática
Tabla con columnas | Dijiste | Correcto | Por qué |. Máximo 8 filas, las más importantes.

## Traducciones literales del español
Lista de calcos detectados y cómo lo diría un nativo. Si no hay, dilo en una línea.

## Vocabulario para subir de nivel
5 expresiones que encajaban en esta conversación y no usó, cada una con un ejemplo tomado del contexto real.

## Fluidez
Muletillas, repeticiones, frases inacabadas. Menciónalo solo si hay evidencia en la transcripción.

## Nivel y plan
Nivel CEFR aproximado con una frase de justificación y tres ejercicios concretos para esta semana.`;

export async function askReport({ turns, settings }) {
  const mine = turns.filter((t) => t.speaker === 'me').length;
  if (mine === 0) throw new CoachError('No hay intervenciones tuyas para analizar.');
  const texto = turnsToText(turns, 400, REPORT_MAX_CHARS);
  const recortada = texto.split('\n').length < turns.length;
  return ask({
    provider: settings.reportProvider,
    model: settings.reportModel,
    keys: settings,
    system: REPORT_SYSTEM,
    user: `Nivel declarado: ${settings.level}. Contexto: ${settings.situation}.${profileBlock(settings)}\n\n`
      + `Transcripción${recortada ? ' (sólo la parte final de la conversación)' : ' completa'}:\n${texto}`,
    maxTokens: 2500,
  });
}
