import test from 'node:test';
import assert from 'node:assert/strict';
import { sizing, emptyMemory, reconcile, selectChunk, linesOf } from './memory.js';
import { normalizeText, acceptItems, acceptErrors, mergeTopics } from './memory.js';
import { Ledger } from './memory.js';

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

test('normalizeText folds case, punctuation and whitespace', () => {
  assert.equal(normalizeText('  It DEPENDS, of the API!  '), 'it depends of the api');
});

test('normalizeText folds accents, so the Spanish stopword list can be plain', () => {
  assert.equal(normalizeText('¿Y qué pasa con el despliegue?'), 'y que pasa con el despliegue');
});

test('acceptItems keeps only items whose quote is verbatim in the chunk', () => {
  const chunk = [turn('them', 'We agreed to ship the retry policy on Friday', 100)];
  const out = acceptItems([
    { text: 'Retry policy ships Friday', quote: 'ship the retry policy on Friday' },
    { text: 'They approved the budget', quote: 'the budget was approved yesterday' },
  ], chunk);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Retry policy ships Friday');
  assert.equal(out[0].t, 100);
});

test('acceptItems rejects a quote too short to prove anything', () => {
  const chunk = [turn('them', 'We agreed to ship it', 100)];
  assert.deepEqual(acceptItems([{ text: 'x', quote: 'ship' }], chunk), []);
});

test('acceptErrors anchors the wrong pair to a LEARNER line and derives said/t', () => {
  const chunk = [
    turn('them', 'It depends of the load, right?', 100),
    turn('me', 'Yes, it depends of the load in production', 200),
  ];
  const out = acceptErrors([{ wrong: 'depends of', right: 'depends on', kind: 'grammar' }], chunk);
  assert.equal(out.length, 1);
  assert.equal(out[0].said, 'Yes, it depends of the load in production');
  assert.equal(out[0].t, 200);
});

test('acceptErrors refuses to attribute the other speaker words to the learner', () => {
  const chunk = [turn('them', 'It depends of the load', 100), turn('me', 'Sure', 200)];
  assert.deepEqual(acceptErrors([{ wrong: 'depends of', right: 'depends on' }], chunk), []);
});

test('acceptErrors drops a correction that changes nothing', () => {
  const chunk = [turn('me', 'I have five years working here', 100)];
  assert.deepEqual(acceptErrors([{ wrong: 'five years', right: 'Five  years.' }], chunk), []);
});

test('acceptErrors drops a whole paragraph posing as a minimal pair', () => {
  const long = 'a'.repeat(80);
  const chunk = [turn('me', long, 100)];
  assert.deepEqual(acceptErrors([{ wrong: long, right: 'something else' }], chunk), []);
});

test('acceptErrors defaults an unknown kind to grammar', () => {
  const chunk = [turn('me', 'I am agree with that', 100)];
  assert.equal(acceptErrors([{ wrong: 'I am agree', right: 'I agree', kind: 'nonsense' }], chunk)[0].kind, 'grammar');
});

test('mergeTopics folds a topic split across two rounds', () => {
  const existing = [{ text: 'The retry policy for the payment gateway', quote: 'q1', t: 1 }];
  const out = mergeTopics(existing, [{ text: 'The retry policy for the payment gateway was discussed', quote: 'q2', t: 2 }], 60);
  assert.equal(out.length, 1);
});

test('mergeTopics caps and drops the oldest', () => {
  const existing = Array.from({ length: 60 }, (_, i) => ({ text: `topic ${i}`, quote: 'q', t: i }));
  const out = mergeTopics(existing, [{ text: 'brand new topic here', quote: 'q', t: 999 }], 60);
  assert.equal(out.length, 60);
  assert.equal(out[out.length - 1].t, 999);
  assert.ok(!out.some((x) => x.t === 0));
});

test('the ledger only counts the last minute', () => {
  let clock = 0;
  const ledger = new Ledger(() => clock);
  ledger.spend('hints');           // 1400
  clock = 30000;
  ledger.spend('hints');           // 1400
  assert.equal(ledger.spent(), 2800);
  clock = 61000;                   // the first one has aged out
  assert.equal(ledger.spent(), 1400);
});

test('the ledger refuses a round that would breach the safety margin', () => {
  let clock = 0;
  const ledger = new Ledger(() => clock);
  for (let i = 0; i < 4; i++) ledger.spend('hints');   // 5600 of 8000
  assert.equal(ledger.room(8000, 'distill'), false);   // 5600 + 1300 > 8000 * 0.75
});

test('the ledger always has room on an unmetered provider', () => {
  const ledger = new Ledger(() => 0);
  for (let i = 0; i < 20; i++) ledger.spend('report');
  assert.equal(ledger.room(null, 'distill'), true);
});
