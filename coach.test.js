import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, turnsToText, contextBlock, CONTEXT_MAX_CHARS, askReply, askReport } from './coach.js';

test('parseReply returns one speakable answer and two study ideas, cleaned', () => {
  const raw = JSON.stringify({
    answer: [{ en: '"I return a **503** error. Then I queue the request."', es: 'devuelvo un 503' }],
    ideas: [{ en: 'idea one', es: '1' }, { en: 'idea two', es: '2' }, { en: 'idea three', es: '3' }],
  });
  const out = parseReply(raw);
  assert.equal(out.answer.length, 1);
  assert.equal(out.answer[0].en, 'I return a **503** error. Then I queue the request.');
  assert.equal(out.ideas.length, 2);
  assert.ok(!('openers' in out));
});

test('parseReply keeps only the first answer option', () => {
  const item = (n) => ({ en: `Answer ${n}.`, es: `respuesta ${n}` });
  const out = parseReply(JSON.stringify({ answer: [item(1), item(2)], ideas: [] }));
  assert.equal(out.answer.length, 1);
  assert.equal(out.answer[0].en, 'Answer 1.');
});

test('parseReply tolerates a model that omits the answer field', () => {
  const raw = JSON.stringify({ ideas: [{ en: 'Just an idea.', es: 'una idea' }] });
  const out = parseReply(raw);
  assert.deepEqual(out.answer, []);
  assert.equal(out.ideas.length, 1);
});

test('parseReply accepts JSON inside a markdown fence', () => {
  const raw = '```json\n{"answer":[{"en":"It depends on the budget.","es":"depende del presupuesto"}],"ideas":[]}\n```';
  assert.equal(parseReply(raw).answer[0].en, 'It depends on the budget.');
});

test('parseReply rejects unusable replies', () => {
  assert.throws(() => parseReply('the model rambled with no JSON'));
  assert.throws(() => parseReply(JSON.stringify({ answer: [], ideas: [] })));
});

test('turnsToText keeps the newest turns within the character budget', () => {
  const turns = [
    { speaker: 'them', text: 'First long question about signals in Angular.' },
    { speaker: 'me', text: 'My previous answer.' },
    { speaker: 'them', text: 'Second question.' },
  ];
  const all = turnsToText(turns, 10);
  assert.ok(all.includes('First long question'));
  const capped = turnsToText(turns, 10, 60);
  assert.ok(capped.includes('LEARNER: My previous answer.'));
  assert.ok(capped.includes('OTHER: Second question.'));
  assert.ok(!capped.includes('First long question'));
});

test('turnsToText always keeps at least the last turn, even over budget', () => {
  const turns = [{ speaker: 'them', text: 'A question far longer than any tiny budget allows.' }];
  assert.ok(turnsToText(turns, 10, 5).includes('tiny budget'));
});

test('contextBlock is empty when there are no notes', () => {
  assert.equal(contextBlock({}), '');
  assert.equal(contextBlock({ sessionContext: '   ' }), '');
});

test('contextBlock carries the notes, capped at the limit', () => {
  const block = contextBlock({ sessionContext: 'Angular interview: signals, RxJS' });
  assert.ok(block.includes('Angular interview: signals, RxJS'));
  const long = contextBlock({ sessionContext: 'x'.repeat(CONTEXT_MAX_CHARS + 500) });
  assert.ok(!long.includes('x'.repeat(CONTEXT_MAX_CHARS + 1)));
  assert.ok(long.includes('x'.repeat(CONTEXT_MAX_CHARS)));
});

// Stub for the Groq endpoint, shared by the tests below: captures the request
// body instead of hitting the network.
function stubGroq(capture, content) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capture.url = url;
    capture.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return () => { globalThis.fetch = original; };
}

const REPLY_SETTINGS = {
  reportProvider: 'groq',
  reportModel: 'openai/gpt-oss-120b',
  groqKey: 'gsk_test_key_for_unit_tests',
  level: 'B1-B2',
  situation: 'conversación de trabajo en inglés',
  lang: 'en',
};
const REPLY_JSON = JSON.stringify({
  answer: [{ en: 'It depends on the load.', es: 'depende de la carga' }],
  ideas: [{ en: 'idea', es: 'idea' }],
});

test('askReply clips a repetition-loop turn out of its prompt', async () => {
  const loop = { speaker: 'me', text: 'be able to '.repeat(400) };
  const seen = {};
  const restore = stubGroq(seen, REPLY_JSON);
  try {
    await askReply({
      turns: [{ speaker: 'them', text: 'How is the migration going?' }, loop],
      settings: REPLY_SETTINGS,
    });
  } finally { restore(); }
  const user = seen.body.messages.find((m) => m.role === 'user').content;
  assert.ok(!user.includes('be able to '.repeat(50)), 'the repetition loop reached the prompt whole');
  assert.ok(user.length < 2500, `reply prompt grew to ${user.length} chars`);
});

test('askReport marks the transcript partial when a turn is clipped, even if none is dropped', async () => {
  // Short enough that no turn is dropped for REPORT_MAX_CHARS, long enough that this
  // one turn alone crosses TURN_MAX_CHARS and gets truncated by clip().
  const loop = { speaker: 'me', text: 'be able to '.repeat(60) };
  const turns = [{ speaker: 'them', text: 'How did the migration go?' }, loop];
  const seen = {};
  const restore = stubGroq(seen, 'Informe de prueba.');
  try {
    await askReport({ turns, settings: REPLY_SETTINGS });
  } finally { restore(); }
  const user = seen.body.messages.find((m) => m.role === 'user').content;
  assert.ok(!user.includes('Transcripción completa'), 'a clipped turn is reported as a complete transcript');
  assert.ok(user.includes('sólo la parte final de la conversación'), 'a clipped turn should mark the transcript as partial');
});
