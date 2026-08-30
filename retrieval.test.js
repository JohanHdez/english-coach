import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, buildIndex, queryFrom, scoreTurns } from './retrieval.js';
import { route } from './retrieval.js';

const turn = (speaker, text, t) => ({ speaker, text, t, dur: 1 });

test('tokenize drops stopwords in both languages and very short words', () => {
  assert.deepEqual(tokenize('And what about the deployment of the gateway?'), ['deployment', 'gateway']);
  assert.deepEqual(tokenize('¿Y qué pasa con el despliegue del gateway?'), ['pasa', 'despliegue', 'gateway']);
});

test('buildIndex gives a rare term more weight than a common one', () => {
  const turns = [
    turn('them', 'the deployment was fine', 1),
    turn('me', 'the deployment is fine', 2),
    turn('them', 'kubernetes was the problem', 3),
  ];
  const { idf } = buildIndex(turns);
  assert.ok(idf.get('kubernetes') > idf.get('deployment'));
});

test('queryFrom joins the trailing run of OTHER turns, not just the last one', () => {
  const turns = [
    turn('me', 'my answer', 1),
    turn('them', 'So going back', 2),
    turn('them', 'to the retry policy you mentioned', 3),
  ];
  assert.equal(queryFrom(turns), 'So going back to the retry policy you mentioned');
});

test('queryFrom returns empty when the learner spoke last', () => {
  assert.equal(queryFrom([turn('them', 'hi', 1), turn('me', 'hello', 2)]), '');
});

test('scoreTurns ranks the turn that shares the rare terms', () => {
  const corpus = [
    turn('me', 'I like coffee in the morning', 1),
    turn('me', 'We set the retry policy to three attempts', 2),
  ];
  const index = buildIndex(corpus);
  const { scored } = scoreTurns(corpus, 'what was the retry policy', index);
  assert.equal(scored[0].turn.t, 2);
  assert.ok(scored[0].score > scored[1].score);
});

test('a pronominal follow-up is a continuation, never a new topic', () => {
  assert.equal(route(tokenize('And how would you do that?'), 0), 'continuation');
  assert.equal(route(tokenize('¿Y eso por qué?'), 0), 'continuation');
});

test('content terms that match earlier turns are anchored', () => {
  assert.equal(route(['retry', 'policy'], 0.8), 'anchored');
});

test('content terms with no match are a new topic', () => {
  assert.equal(route(['promise', 'javascript'], 0.1), 'new');
});

test('the boundary case falls to new — the costs are asymmetric', () => {
  assert.equal(route(['retry', 'policy'], 0.34), 'new');
  assert.equal(route(['retry', 'policy'], 0.35), 'anchored');
});

test('with no past to be absent from, content terms never route to new', () => {
  assert.equal(route(['promise', 'javascript'], 0, false), 'continuation');
});

test('hasPast defaults to true, so every existing caller keeps its behaviour', () => {
  assert.equal(route(['promise', 'javascript'], 0.1), 'new');
});

import { buildReplyContext } from './retrieval.js';

const long = (word, n) => `${word} `.repeat(n).trim();

test('the tail and the memory leave no gap between them', () => {
  const turns = [
    turn('me', long('alpha', 100), 1000),
    turn('them', long('beta', 100), 2000),
    turn('them', 'and what about the kubernetes migration', 3000),
  ];
  const ctx = buildReplyContext({ turns, memory: {}, tailChars: 2700, room: {} });
  assert.ok(ctx.tail.includes('kubernetes migration'));
});

test('an anchored question gets verbatim evidence and nothing invented', () => {
  const turns = [
    turn('me', 'We set the kubernetes migration for the second quarter', 1000),
    ...Array.from({ length: 30 }, (_, i) => turn(i % 2 ? 'me' : 'them', long('filler', 40), 2000 + i * 100)),
    turn('them', 'remind me about the kubernetes migration', 9000),
  ];
  const ctx = buildReplyContext({ turns, memory: {}, tailChars: 800, room: {} });
  assert.equal(ctx.mode, 'anchored');
  assert.ok(ctx.evidence.some((t) => t.text.includes('second quarter')));
});

// The whole (short) conversation fits in the tail, so `older` is empty and there
// is nothing for the question to be absent from. Declaring "new" here would tell
// the model NOTHING covers this question directly above a RECENT block holding
// the entire conversation — worse than saying nothing at all.
test('a conversation short enough that older is empty is a continuation, never a declared absence', () => {
  const turns = [
    turn('me', 'We set the kubernetes migration for the second quarter', 1000),
    turn('them', 'what is a promise in javascript', 2000),
  ];
  const ctx = buildReplyContext({ turns, memory: {}, tailChars: 200, room: {} });
  assert.equal(ctx.mode, 'continuation');
  assert.deepEqual(ctx.evidence, []);
});

// Same unrelated question, but the transcript is long enough that some turns
// fall outside the tail: `older` is non-empty, so "new" is still reachable.
test('once the transcript has a past, an unrelated question still routes to new', () => {
  const turns = [
    turn('me', 'We set the kubernetes migration for the second quarter', 1000),
    ...Array.from({ length: 30 }, (_, i) => turn(i % 2 ? 'me' : 'them', long('filler', 40), 2000 + i * 100)),
    turn('them', 'what is a promise in javascript', 9000),
  ];
  const ctx = buildReplyContext({ turns, memory: {}, tailChars: 800, room: {} });
  assert.equal(ctx.mode, 'new');
  assert.deepEqual(ctx.evidence, []);
});

test('a squeezed budget drops evidence before topics, and never the tail', () => {
  const turns = [
    turn('me', 'We set the kubernetes migration for the second quarter', 1000),
    ...Array.from({ length: 30 }, (_, i) => turn(i % 2 ? 'me' : 'them', long('filler', 40), 2000 + i * 100)),
    turn('them', 'remind me about the kubernetes migration', 9000),
  ];
  const memory = { topics: [{ text: 'Migration planned for Q2', quote: 'q', t: 1000 }] };
  const ctx = buildReplyContext({ turns, memory, tailChars: 800, room: { evidence: false } });
  assert.deepEqual(ctx.evidence, []);
  assert.equal(ctx.situation.length, 1);
  assert.ok(ctx.tail.length > 0);
});

test('evidence never repeats what the tail already carries', () => {
  const turns = [
    turn('them', 'tell me about the kubernetes migration', 1000),
    turn('me', 'the kubernetes migration is in Q2', 2000),
    turn('them', 'and the kubernetes migration budget', 3000),
  ];
  const ctx = buildReplyContext({ turns, memory: {}, tailChars: 5000, room: {} });
  assert.deepEqual(ctx.evidence, []);
});
