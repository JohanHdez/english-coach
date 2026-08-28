import test from 'node:test';
import assert from 'node:assert/strict';
import { sizing, emptyMemory, reconcile, selectChunk, linesOf } from './memory.js';

const turn = (speaker, text, t, dur = 1) => ({ speaker, text, t, dur });
const filler = (n) => 'word '.repeat(n).trim();

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

test('linesOf labels the speakers the way the coach prompts expect', () => {
  assert.equal(linesOf([turn('me', 'hi', 1), turn('them', 'yo', 2)]), 'LEARNER: hi\nOTHER: yo');
});

test('selectChunk never includes the newest turn, which folding can still grow', () => {
  const turns = [
    turn('them', filler(200), 1000),
    turn('me', filler(200), 20000),
    turn('them', filler(200), 40000),
  ];
  const chunk = selectChunk(turns, { coveredUntil: 0 }, 1800);
  assert.ok(chunk);
  assert.ok(chunk.turns.every((t) => t.t !== 40000));
  assert.equal(chunk.endsAt, 20000);
});

test('selectChunk returns null below the chunk size', () => {
  const turns = [turn('them', 'short', 1000), turn('me', 'also short', 2000), turn('them', 'x', 3000)];
  assert.equal(selectChunk(turns, { coveredUntil: 0 }, 1800), null);
});

test('selectChunk cuts at the largest silence inside the band', () => {
  // Each turn is ~500 chars. The band for 1800 is [1440, 2160], so the cut can
  // land after turn 3 (~1500) or turn 4 (~2000). Turn 3 is followed by a 6 s
  // silence and turn 4 by 200 ms, so the cut must land after turn 3.
  const turns = [
    turn('them', filler(100), 0, 5),
    turn('me', filler(100), 6000, 5),
    turn('them', filler(100), 12000, 5),
    turn('me', filler(100), 23000, 5),   // 6 s gap before this one
    turn('them', filler(100), 28200, 5), // 200 ms gap before this one
    turn('me', filler(100), 34000, 5),
  ];
  const chunk = selectChunk(turns, { coveredUntil: 0 }, 1800);
  assert.equal(chunk.endsAt, 12000);
});

test('selectChunk caps a backlogged chunk instead of sending one huge block', () => {
  const turns = Array.from({ length: 40 }, (_, i) => turn(i % 2 ? 'me' : 'them', filler(100), i * 1000, 0.5));
  const chunk = selectChunk(turns, { coveredUntil: 0 }, 1800);
  assert.ok(chunk.chars <= 1800 * 1.5);
});

test('selectChunk takes an oversized single turn whole — turns are atomic', () => {
  const turns = [turn('me', filler(1000), 1000, 20), turn('them', 'ok', 30000)];
  const chunk = selectChunk(turns, { coveredUntil: 0 }, 1800);
  assert.equal(chunk.turns.length, 1);
  assert.ok(chunk.chars > 1800 * 1.5);
});

test('the final flush takes everything left, newest turn included', () => {
  const turns = [turn('them', 'short one', 1000), turn('me', 'short two', 2000), turn('them', 'last word', 3000)];
  assert.equal(selectChunk(turns, { coveredUntil: 0 }, 1800), null);
  const flush = selectChunk(turns, { coveredUntil: 0 }, 1800, { all: true });
  assert.equal(flush.turns.length, 3);
  assert.equal(flush.endsAt, 3000);
});

test('the final flush returns null when everything is already covered', () => {
  const turns = [turn('me', 'hi', 1000), turn('them', 'yo', 2000)];
  assert.equal(selectChunk(turns, { coveredUntil: 2000 }, 1800, { all: true }), null);
});

test('selectChunk carries the tail of what was already distilled as overlap', () => {
  const turns = [
    turn('them', 'previously agreed on the retry policy', 1000),
    turn('me', filler(200), 10000),
    turn('them', filler(200), 20000),
    turn('me', 'still talking', 30000),
  ];
  const chunk = selectChunk(turns, { coveredUntil: 1000 }, 1800);
  assert.ok(chunk.overlap.includes('retry policy'));
  assert.ok(!chunk.text.includes('retry policy'));
});
