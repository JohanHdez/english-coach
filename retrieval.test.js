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
