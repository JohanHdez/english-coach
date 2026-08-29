import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, parseHints, turnsToText, contextBlock, CONTEXT_MAX_CHARS } from './coach.js';
import { parseDistill, tpmOf, PROVIDERS } from './coach.js';

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

test('parseHints returns capped words, cleaned openers and the nudge', () => {
  const raw = JSON.stringify({
    words: [{ en: 'w1', es: '' }, { en: 'w2', es: '' }, { en: 'w3', es: '' }, { en: 'w4', es: '' }, { en: 'w5', es: '' }],
    openers: [{ en: '"Well, the way I see it,"', es: 'bueno' }, { en: '', es: 'vacío' }],
    nudge: 'directo y corto',
  });
  const out = parseHints(raw);
  assert.equal(out.words.length, 4);
  assert.equal(out.openers.length, 1);
  assert.equal(out.openers[0].en, 'Well, the way I see it,');
  assert.equal(out.nudge, 'directo y corto');
});

test('parseHints rejects a reply without words', () => {
  assert.throws(() => parseHints(JSON.stringify({ openers: [], nudge: '' })));
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

test('every provider declares a per-minute budget', () => {
  for (const spec of Object.values(PROVIDERS)) assert.ok('tpm' in spec);
});

test('tpmOf takes the tightest budget in play', () => {
  assert.equal(tpmOf({ liveProvider: 'groq', reportProvider: 'groq' }), 8000);
  assert.equal(tpmOf({ liveProvider: 'anthropic', reportProvider: 'anthropic' }), null);
  // Mixed: the metered half is the one that can 429, so it sets the policy.
  assert.equal(tpmOf({ liveProvider: 'groq', reportProvider: 'anthropic' }), 8000);
  assert.equal(tpmOf({ liveProvider: 'nope', reportProvider: 'nope' }), 8000);
});

test('parseDistill returns the four groups and tolerates missing ones', () => {
  const out = parseDistill(JSON.stringify({ topics: [{ text: 'a', quote: 'bbbbbbbbbbbb' }] }));
  assert.equal(out.topics.length, 1);
  assert.deepEqual(out.open, []);
  assert.deepEqual(out.errors, []);
  assert.equal(out.carry, '');
});

test('parseDistill reads a fenced JSON block', () => {
  const raw = '```json\n{"topics":[],"open":[],"errors":[],"carry":"still on pricing"}\n```';
  assert.equal(parseDistill(raw).carry, 'still on pricing');
});

test('parseDistill throws on unusable output rather than returning a shell', () => {
  assert.throws(() => parseDistill('the model said hello'));
});

// append to coach.test.js
import { contextBlocks } from './coach.js';

test('an anchored context prints the literal record', () => {
  const out = contextBlocks({
    mode: 'anchored',
    situation: [{ text: 'Migration planned for Q2' }],
    evidence: [{ speaker: 'me', text: 'the migration is in Q2' }],
    tail: 'OTHER: and the budget?',
  });
  assert.match(out, /SITUATION/);
  assert.match(out, /LITERAL RECORD/);
  assert.match(out, /the migration is in Q2/);
  assert.match(out, /OTHER: and the budget\?/);
});

test('a new question states the absence instead of omitting the block', () => {
  const out = contextBlocks({ mode: 'new', situation: [], evidence: [], tail: 'OTHER: what is a promise?' });
  assert.match(out, /NOTHING earlier in this conversation covers this question/);
  assert.ok(!out.includes('LITERAL RECORD'));
});

test('a continuation neither claims nor denies earlier coverage', () => {
  const out = contextBlocks({ mode: 'continuation', situation: [], evidence: [], tail: 'OTHER: and why?' });
  assert.ok(!out.includes('LITERAL RECORD'));
  assert.ok(!out.includes('NOTHING earlier'));
});
