import test from 'node:test';
import assert from 'node:assert/strict';
import { sizing, emptyMemory, reconcile } from './memory.js';

test('sizing derives the chunk and tail from the provider budget', () => {
  assert.deepEqual(sizing(8000), { chunkChars: 1800, tailChars: 2700 });
  assert.deepEqual(sizing(null), { chunkChars: 4000, tailChars: 6000 });
});

test('the reply tail always covers at least one and a half chunks', () => {
  for (const tpm of [8000, null]) {
    const { chunkChars, tailChars } = sizing(tpm);
    assert.ok(tailChars >= chunkChars * 1.5);
  }
});

test('emptyMemory starts uncovered', () => {
  const m = emptyMemory('s1');
  assert.equal(m.sessionId, 's1');
  assert.equal(m.coveredUntil, 0);
  assert.deepEqual(m.topics, []);
  assert.equal(m.merged, false);
});

test('reconcile resets a memory that outruns its transcript', () => {
  const m = { ...emptyMemory('s1'), coveredUntil: 9000, topics: [{ text: 'x', quote: 'y', t: 10 }] };
  const fresh = reconcile(m, [{ speaker: 'me', text: 'hi', t: 100, dur: 1 }]);
  assert.equal(fresh.coveredUntil, 0);
  assert.deepEqual(fresh.topics, []);
  assert.equal(fresh.sessionId, 's1');
});

test('reconcile resets when the transcript was cleared', () => {
  const m = { ...emptyMemory('s1'), coveredUntil: 50 };
  assert.equal(reconcile(m, []).coveredUntil, 0);
});

test('reconcile keeps a consistent memory untouched', () => {
  const m = { ...emptyMemory('s1'), coveredUntil: 100 };
  const turns = [{ speaker: 'me', text: 'hi', t: 100, dur: 1 }, { speaker: 'them', text: 'yo', t: 200, dur: 1 }];
  assert.equal(reconcile(m, turns), m);
});
